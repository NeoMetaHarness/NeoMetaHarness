import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse, parseDocument, stringify } from 'yaml';
import { defineExtension } from '@neometaharness/kernel';
import {
  HermesProjector, DshProjector, restrictPrivatePath, type VaultScope, type VaultService,
} from '@neometaharness/vault';

const exec = promisify(execFile);
const telegramKey = 'TELEGRAM_BOT_TOKEN';
/** Per-profile secret the neo-channels Hermes plugin presents on inbound callbacks. */
const whatsappTokenKey = 'NEO_CHANNELS_TOKEN';
const pluginName = 'neo-channels';
const pluginAssets = fileURLToPath(new URL('./whatsapp-plugin/', import.meta.url));
const profilePattern = /^(default|[a-z][a-z0-9_-]{0,47})$/;
const chatPattern = /^[0-9A-Za-z@._-]{3,120}$/;

type SenderRole = 'viewer' | 'member' | 'admin';
interface WhatsAppSender { role: SenderRole; hermesId?: string }
interface WhatsAppProfile { botId: string; senders: Record<string, WhatsAppSender> }
interface ChannelState { whatsapp: Record<string, WhatsAppProfile> }

interface HermesChannels {
  channelRuntime(profile: string): { home: string; python: string; upstream: string };
  channelPlatforms(profile: string): Promise<{ platforms: Record<string, unknown>[] }>;
  channelEnabled(profile: string, platform: string, enabled: boolean): Promise<void>;
  listProfiles(): Promise<{ profiles: { name: string }[] }>;
}

/** The gateway's ChannelBus (apps/gateway/src/channel-bus.ts), structurally. */
interface ChannelBus {
  readonly listening: boolean;
  emit(message: { id: string; channelId: string; botId: string; senderId: string;
    memberRole: SenderRole; text: string; mode?: 'observe' | 'act' }): Promise<void>;
  attach(id: string, platform: {
    inbound(request: { authorization?: string; body: unknown }): Promise<{ status: number; body?: unknown }>;
    deliver(reply: { channelId: string; inReplyTo: string; text: string }): Promise<void>;
  }): () => void;
}

export interface ChannelsOptions {
  bus?: ChannelBus;
  /** Directory for the channel state file (WhatsApp bot binding and sender allowlist). */
  dataDir?: string;
  gatewayUrl?: () => string;
}

function canonical(profile: string): string {
  const name = profile.trim().toLowerCase();
  if (!profilePattern.test(name)) throw new Error('Invalid channel profile');
  return name;
}

function scope(profile: string): VaultScope {
  return { kind: 'engine', workspaceId: 'default', subjectId: `engine-hermes/${canonical(profile)}` };
}

/** A WhatsApp identity (`15550001111`, `15550001111@s.whatsapp.net`, `15550001111:3@s.whatsapp.net`) as digits. */
export function normalizeSender(id: string): string | undefined {
  const digits = id.trim().replace(/^\+/, '').split('@', 1)[0]!.split(':', 1)[0]!;
  return /^\d{6,20}$/.test(digits) ? digits : undefined;
}

const mentionsNeo = (text: string) => /(^|\s)@neo\b/i.test(text);

function platformMetadata(raw: Record<string, unknown>) {
  return {
    id: String(raw.id ?? ''), name: String(raw.name ?? ''),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    enabled: raw.enabled === true, configured: raw.configured === true,
    gatewayRunning: raw.gateway_running === true,
    ...(typeof raw.error_message === 'string' && raw.error_message ? { error: raw.error_message } : {}),
  };
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await restrictPrivatePath(temporary);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('Could not reserve a WhatsApp bridge port');
  return address.port;
}

/** Hermes' get_hermes_dir: only a populated legacy dir wins (hermes_constants.py:510-522 at v0.23.2). */
function hermesDir(home: string, current: string, legacy: string): string {
  const old = join(home, legacy);
  let populated = false;
  try { populated = readdirSync(old).length > 0; } catch { /* absent */ }
  return populated ? old : join(home, current);
}

/** Platform configuration stays in Hermes. The vault is the sole owner of channel secrets. */
export class ChannelsRuntime {
  private readonly processes = new Map<string, ChildProcess>();
  private readonly projections = new Map<string, () => void>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private state?: ChannelState;
  private detach?: () => void;
  private closing = false;

  constructor(private readonly hermes: HermesChannels, private readonly vault: VaultService,
    private readonly options: ChannelsOptions = {}) {
    this.detach = options.bus?.attach('whatsapp', {
      inbound: (request) => this.inbound(request),
      deliver: (reply) => this.deliver(reply),
    });
  }

  private async serialize<T>(profile: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(profile) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.mutations.set(profile, current);
    try { return await current; }
    finally {
      if (this.mutations.get(profile) === current) this.mutations.delete(profile);
    }
  }

  /**
   * Hermes runs the WhatsApp bridge only with a Node its package manager installed
   * (hermes_constants.py:587-609 find_node_executable; never PATH). One shared PM store
   * (HERMES_RUNTIME_DIR, pm/environments.py:220-232) lets every Hermes root reuse it.
   */
  private get runtimeDir(): string | undefined {
    return process.env.NMH_HERMES_RUNTIME_DIR
      ?? (this.options.dataDir ? join(this.options.dataDir, 'channels', 'hermes-runtime') : undefined);
  }

  private async ensureNode(name: string): Promise<void> {
    const probe = 'from hermes_constants import find_node_executable as f; print(f("node") or "")';
    if ((await this.hermesPython(name, ['-c', probe])).trim()) return;
    // Pinned, sha256-verified artifact from Hermes' own lock (pm/lock.json); first use downloads it.
    await this.hermesCli(name, ['pm', 'install', 'node'], undefined, 15 * 60_000);
  }

  private get stateFile(): string | undefined {
    return this.options.dataDir ? join(this.options.dataDir, 'channels', 'state.json') : undefined;
  }

  private async whatsappProfiles(): Promise<Record<string, WhatsAppProfile>> {
    if (!this.state) {
      let loaded: ChannelState = { whatsapp: {} };
      if (this.stateFile) {
        try {
          const stored = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<ChannelState>;
          loaded = { whatsapp: stored.whatsapp ?? {} };
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      this.state = loaded;
    }
    return this.state.whatsapp;
  }

  private async saveState(): Promise<void> {
    if (this.stateFile && this.state) await writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2) + '\n');
  }

  private async project(profile: string): Promise<void> {
    const name = canonical(profile);
    if (!this.projections.has(name)) {
      const { home } = this.hermes.channelRuntime(name);
      this.projections.set(name, this.vault.bind(scope(name), new HermesProjector(home, [telegramKey])));
    }
    await this.vault.sync(scope(name));
  }

  async list(profile: string) {
    const name = canonical(profile);
    const response = await this.hermes.channelPlatforms(name);
    return { platforms: response.platforms.map(platformMetadata) };
  }

  async status(profile: string) {
    const name = canonical(profile);
    const result = await this.list(name);
    const configured = !!(await this.vault.get(scope(name), telegramKey));
    const whatsapp = (await this.whatsappProfiles())[name];
    const child = this.processes.get(name);
    const running = !!child && child.exitCode === null;
    return { platforms: result.platforms.map((item) => {
      if (item.id === 'telegram') return { ...item, configured, gatewayRunning: running && configured };
      if (item.id === 'whatsapp') {
        const { home } = this.hermes.channelRuntime(name);
        const session = hermesDir(home, 'platforms/whatsapp/session', 'whatsapp/session');
        return { ...item, configured: !!whatsapp, gatewayRunning: running && !!whatsapp,
          paired: existsSync(join(session, 'creds.json')) };
      }
      return item;
    }) };
  }

  async connect(input: { profile: string; platform: 'telegram' | 'whatsapp'; token?: string; botId?: string }) {
    const name = canonical(input.profile);
    return this.serialize(name, async () => {
      if (this.closing) throw new Error('Channels disabled');
      if (input.platform === 'whatsapp') return this.connectWhatsApp(name, String(input.botId ?? ''));
      if (input.platform !== 'telegram') throw new Error('Platform is not supported');
      const token = String(input.token ?? '');
      if (!/^\d{5,20}:[A-Za-z0-9_-]{4,}$/.test(token)) throw new Error('Invalid Telegram bot token');
      if (!(await this.list(name)).platforms.some((item) => item.id === 'telegram')) {
        throw new Error('Hermes does not expose this platform');
      }
      await this.project(name);
      // A reconnect rotates the secret and tears down the old gateway before launching it again.
      await this.stop(name);
      await this.vault.put(scope(name), telegramKey, token);
      await this.hermes.channelEnabled(name, 'telegram', true);
      await this.start(name);
      return { connected: this.processes.get(name)?.exitCode === null };
    });
  }

  private async connectWhatsApp(name: string, botId: string) {
    if (!this.options.bus || !this.options.gatewayUrl) throw new Error('WhatsApp needs the gateway channel bus');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(botId)) throw new Error('Invalid bot id');
    if (!(await this.list(name)).platforms.some((item) => item.id === 'whatsapp')) {
      throw new Error('Hermes does not expose this platform');
    }
    await this.project(name);
    await this.stop(name);
    if (!(await this.vault.get(scope(name), whatsappTokenKey))) {
      await this.vault.put(scope(name), whatsappTokenKey, randomBytes(32).toString('hex'));
    }
    const profiles = await this.whatsappProfiles();
    profiles[name] = { botId, senders: profiles[name]?.senders ?? {} };
    await this.saveState();
    await this.ensureNode(name);
    await this.hermes.channelEnabled(name, 'whatsapp', true);
    await this.start(name);
    return { connected: this.processes.get(name)?.exitCode === null };
  }

  async disconnect(profile: string, platform: 'telegram' | 'whatsapp') {
    const name = canonical(profile);
    return this.serialize(name, async () => {
      if (this.closing) throw new Error('Channels disabled');
      if (platform !== 'telegram' && platform !== 'whatsapp') throw new Error('Unsupported channel');
      await this.project(name);
      await this.stop(name);
      await this.hermes.channelEnabled(name, platform, false);
      if (platform === 'telegram') {
        await this.vault.delete(scope(name), telegramKey);
      } else {
        const profiles = await this.whatsappProfiles();
        delete profiles[name];
        await this.saveState();
        await this.vault.delete(scope(name), whatsappTokenKey);
        await this.removePlugin(name);
      }
      // The other platform on this profile, if any, keeps running.
      await this.start(name);
      return { disconnected: true };
    });
  }

  async senders(profile: string) {
    const name = canonical(profile);
    const profiles = await this.whatsappProfiles();
    return { senders: Object.entries(profiles[name]?.senders ?? {})
      .map(([senderId, { role }]) => ({ senderId, role }))
      .sort((left, right) => left.senderId.localeCompare(right.senderId)) };
  }

  async allow(profile: string, senderId: string, role: SenderRole) {
    const name = canonical(profile);
    return this.serialize(name, async () => {
      const sender = normalizeSender(senderId);
      if (!sender) throw new Error('Invalid WhatsApp sender');
      if (!['viewer', 'member', 'admin'].includes(role)) throw new Error('Invalid sender role');
      const entry = await this.connected(name);
      entry.senders[sender] = { ...entry.senders[sender], role };
      await this.saveState();
      await this.restart(name);
      return this.senders(name);
    });
  }

  async revoke(profile: string, senderId: string) {
    const name = canonical(profile);
    return this.serialize(name, async () => {
      const sender = normalizeSender(senderId);
      if (!sender) throw new Error('Invalid WhatsApp sender');
      const entry = await this.connected(name);
      const hermesId = entry.senders[sender]?.hermesId;
      delete entry.senders[sender];
      await this.saveState();
      // A sender admitted through Hermes pairing is also removed from Hermes' approved list.
      if (hermesId) await this.hermesCli(name, ['pairing', 'revoke', 'whatsapp', hermesId]);
      await this.restart(name);
      return this.senders(name);
    });
  }

  /** Approve a code Hermes DM'd to an unknown sender (hermes_cli/pairing.py:56-81 at v0.23.2). */
  async approve(profile: string, code: string, role: SenderRole) {
    const name = canonical(profile);
    return this.serialize(name, async () => {
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw new Error('Invalid pairing code');
      if (!['viewer', 'member', 'admin'].includes(role)) throw new Error('Invalid sender role');
      const entry = await this.connected(name);
      const { home } = this.hermes.channelRuntime(name);
      // The CLI exits 0 either way, so success is read from Hermes' approved store.
      const before = await this.approvedIds(home);
      await this.hermesCli(name, ['pairing', 'approve', 'whatsapp', code]);
      const added = [...await this.approvedIds(home)].filter((id) => !before.has(id));
      const sender = added.length === 1 ? normalizeSender(added[0]!) : undefined;
      if (!sender) throw new Error('Pairing code not found or expired');
      entry.senders[sender] = { role, hermesId: added[0]! };
      await this.saveState();
      await this.restart(name);
      return { senderId: sender, role };
    });
  }

  private async connected(name: string): Promise<WhatsAppProfile> {
    if (this.closing) throw new Error('Channels disabled');
    const entry = (await this.whatsappProfiles())[name];
    if (!entry) throw new Error('WhatsApp is not connected for this profile');
    return entry;
  }

  /** Hermes' approved store: gateway/pairing.py:58-59,443-452 at v0.23.2. */
  private async approvedIds(home: string): Promise<Set<string>> {
    const file = join(hermesDir(home, 'platforms/pairing', 'pairing'), 'whatsapp-approved.json');
    try { return new Set(Object.keys(JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw error;
    }
  }

  /** Engine callback from the neo-channels plugin, before Hermes' own dispatch. */
  async inbound({ authorization, body }: { authorization?: string; body: unknown }) {
    const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const profile = typeof payload.profile === 'string' && profilePattern.test(payload.profile) ? payload.profile : undefined;
    if (!profile) return { status: 400 };
    const entry = (await this.whatsappProfiles())[profile];
    const provided = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? '')?.[1];
    const expected = entry ? await this.vault.get(scope(profile), whatsappTokenKey) : undefined;
    if (!entry || !provided || !expected || expected.length !== 64
      || !timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) {
      return { status: 401 };
    }
    const { text, senderId, chatId, chatType, messageId } = payload;
    if (payload.platform !== 'whatsapp' || typeof text !== 'string' || text.length > 16000
      || typeof senderId !== 'string' || typeof chatId !== 'string') {
      return { status: 400 };
    }
    const keep = { status: 200, body: { action: 'allow' } };
    const sender = normalizeSender(senderId);
    const role = sender ? entry.senders[sender]?.role : undefined;
    // Groups are off in this slice; unknown senders go to Hermes (pairing or ignore).
    if (chatType !== 'dm' || !role || !mentionsNeo(text) || !chatPattern.test(chatId)
      || this.closing || !this.options.bus?.listening) {
      return keep;
    }
    const id = typeof messageId === 'string' && /^[\w.:@-]{1,200}$/.test(messageId) ? `whatsapp:${messageId}` : randomUUID();
    const message = { id, channelId: `whatsapp:${profile}:${chatId}`, botId: entry.botId, senderId: sender!,
      memberRole: role, text, mode: 'act' as const };
    // The plugin waits on this answer before Hermes dispatches, so the Inbox runs asynchronously.
    void this.options.bus.emit(message).catch((error: unknown) =>
      console.error('WhatsApp to Neo Inbox failed:', error instanceof Error ? error.message : error));
    return { status: 200, body: { action: 'skip' } };
  }

  /** Inbox report back to the WhatsApp chat, through Hermes' send seam (hermes_cli/send_cmd.py:196-289). */
  async deliver(reply: { channelId: string; inReplyTo: string; text: string }) {
    const match = /^whatsapp:([a-z0-9_-]{1,48}):([0-9A-Za-z@._-]{3,120})$/.exec(reply.channelId);
    if (!match || !profilePattern.test(match[1]!)) throw new Error('Invalid WhatsApp channel');
    const [, profile, chatId] = match;
    if (this.closing || !(await this.whatsappProfiles())[profile!]) throw new Error('WhatsApp channel is not connected');
    await this.hermesCli(profile!, ['send', '--to', `whatsapp:${chatId}`], reply.text.slice(0, 4000) || '(empty report)');
  }

  private hermesCli(profile: string, args: string[], input?: string, timeout = 60000): Promise<string> {
    return this.hermesPython(profile, ['-m', 'hermes_cli.main', ...args], input, timeout);
  }

  private async hermesPython(profile: string, args: string[], input?: string, timeout = 60000): Promise<string> {
    const { home, python, upstream } = this.hermes.channelRuntime(profile);
    const env = await new DshProjector([]).project(new Map());
    const child = spawn(python, ['-u', ...args], {
      cwd: upstream, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, HERMES_HOME: home, PYTHONPATH: upstream, PYTHONDONTWRITEBYTECODE: '1',
        HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONIOENCODING: 'utf-8',
        ...(this.runtimeDir ? { HERMES_RUNTIME_DIR: this.runtimeDir } : {}) },
    });
    let output = '';
    child.stdout!.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); });
    child.stderr!.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); });
    child.stdin!.end(input ?? '');
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Hermes CLI timed out: ' + args.join(' ').slice(0, 60))); }, timeout);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (exit) => { clearTimeout(timer); done(exit); });
    });
    if (code !== 0) throw new Error(`Hermes ${args.slice(0, 3).join(' ')} failed (${code}): ${output.trim().slice(-500)}`);
    return output;
  }

  /** The test-only Bot API override is accepted for loopback to prevent remote credential exposure. */
  private async configureStandin(home: string): Promise<void> {
    const base = process.env.NMH_CHANNELS_TELEGRAM_API_BASE;
    if (!base) return;
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password || parsed.pathname !== '/') {
      throw new Error('Telegram test API must be on an isolated loopback port');
    }
    const file = join(home, 'config.yaml');
    const config = parse(await readFile(file, 'utf8')) as Record<string, any>;
    config.platforms ??= {};
    config.platforms.telegram ??= {};
    config.platforms.telegram.enabled = true;
    config.platforms.telegram.extra = {
      ...(config.platforms.telegram.extra ?? {}),
      base_url: `${parsed.origin}/bot`, base_file_url: `${parsed.origin}/file/bot`,
    };
    const temporary = file + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, stringify(config), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  }

  /** Test-only stand-in for Hermes' Node bridge (extra.bridge_script); never honoured outside NODE_ENV=test. */
  private bridgeOverride(): string | undefined {
    const script = process.env.NMH_CHANNELS_WHATSAPP_BRIDGE_SCRIPT;
    if (!script) return undefined;
    if (process.env.NODE_ENV !== 'test' || !isAbsolute(script) || !/\.m?js$/.test(script) || !existsSync(script)) {
      throw new Error('The WhatsApp test bridge is only available to isolated test runs');
    }
    return script;
  }

  /**
   * Install the neo-channels plugin and the WhatsApp platform settings into the
   * profile, through Hermes' public seams: a user plugin plus plugins.enabled
   * (hermes_cli/plugins_discovery.py:269-320) and platforms.whatsapp.extra
   * (plugins/platforms/whatsapp/adapter.py:660-679).
   */
  private async prepareWhatsApp(name: string, home: string, entry: WhatsAppProfile): Promise<Record<string, string>> {
    const token = await this.vault.get(scope(name), whatsappTokenKey);
    if (!token || !this.options.gatewayUrl) throw new Error('WhatsApp callback credentials are missing');
    const plugin = join(home, 'plugins', pluginName);
    await mkdir(plugin, { recursive: true });
    await Promise.all(['plugin.yaml', '__init__.py'].map((file) => copyFile(join(pluginAssets, file), join(plugin, file))));
    await writeAtomic(join(plugin, 'binding.json'), JSON.stringify({
      endpoint: `${this.options.gatewayUrl()}/internal/channels/whatsapp/inbound`, token, profile: name,
    }) + '\n');

    const file = join(home, 'config.yaml');
    const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const document = parseDocument(existing || '{}');
    if (document.errors.length) throw new Error(`Invalid Hermes config for profile ${name}`);
    const enabled = document.getIn(['plugins', 'enabled']);
    const names = Array.isArray((enabled as any)?.toJSON?.()) ? (enabled as any).toJSON() as string[] : [];
    if (!names.includes(pluginName)) document.setIn(['plugins', 'enabled'], [...names, pluginName]);
    // Each profile needs its own bridge port: the adapter frees its port by killing the holder.
    if (!Number(document.getIn(['platforms', 'whatsapp', 'extra', 'bridge_port']))) {
      document.setIn(['platforms', 'whatsapp', 'extra', 'bridge_port'], await freePort());
    }
    const override = this.bridgeOverride();
    if (override) document.setIn(['platforms', 'whatsapp', 'extra', 'bridge_script'], override);
    const next = String(document);
    if (next !== existing) await writeAtomic(file, next);

    const allowed = Object.keys(entry.senders).sort();
    return {
      // Bot mode: a dedicated number. DM pairing stays on so unknown senders get a Hermes code
      // an admin can approve; groups are off in this slice (authz_mixin.py:941-983).
      WHATSAPP_MODE: 'bot', WHATSAPP_DM_POLICY: 'pairing', WHATSAPP_GROUP_POLICY: 'disabled',
      ...(this.runtimeDir ? { HERMES_RUNTIME_DIR: this.runtimeDir } : {}),
      ...(allowed.length ? { WHATSAPP_ALLOWED_USERS: allowed.join(',') } : {}),
    };
  }

  private async removePlugin(name: string): Promise<void> {
    let home: string;
    try { ({ home } = this.hermes.channelRuntime(name)); } catch { return; }
    await rm(join(home, 'plugins', pluginName), { recursive: true, force: true });
    const file = join(home, 'config.yaml');
    const existing = await readFile(file, 'utf8').catch(() => '');
    if (!existing) return;
    const document = parseDocument(existing);
    const enabled = (document.getIn(['plugins', 'enabled']) as any)?.toJSON?.();
    if (Array.isArray(enabled) && enabled.includes(pluginName)) {
      document.setIn(['plugins', 'enabled'], enabled.filter((item: string) => item !== pluginName));
      await writeAtomic(file, String(document));
    }
  }

  private async start(profile: string): Promise<void> {
    if (this.closing) return;
    const name = canonical(profile);
    const { home, python, upstream } = this.hermes.channelRuntime(name);
    const token = await this.vault.get(scope(name), telegramKey);
    const whatsapp = (await this.whatsappProfiles())[name];
    if (!token && !whatsapp) return;
    if (token) await this.configureStandin(home);
    const safeEnv = await new DshProjector([telegramKey]).project(token ? new Map([[telegramKey, token]]) : new Map());
    const whatsappEnv = whatsapp ? await this.prepareWhatsApp(name, home, whatsapp) : {};
    // Standard gateway boot applies Hermes' env and plugin platform overrides.
    // --config constructs GatewayConfig.from_dict directly, leaving env-sourced bot tokens unset.
    const child = spawn(python, ['-u', '-m', 'gateway.run'], {
      cwd: upstream, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore',
      env: {
        ...safeEnv, ...whatsappEnv, HERMES_HOME: home, PYTHONPATH: upstream, PYTHONDONTWRITEBYTECODE: '1',
        HERMES_DISABLE_LAZY_INSTALLS: '1',
        HERMES_TELEGRAM_DISABLE_FALLBACK_IPS: '1',
        HERMES_TELEGRAM_TEXT_BATCH_DELAY_SECONDS: '0',
        HERMES_TELEGRAM_TEXT_BATCH_SPLIT_DELAY_SECONDS: '0',
        ...(token && process.env.NMH_CHANNELS_TELEGRAM_API_BASE ? { TELEGRAM_ALLOWED_USERS: '111', TELEGRAM_HOME_CHANNEL: '111' } : {}),
      },
    });
    this.processes.set(name, child);
    child.once('exit', () => { if (this.processes.get(name) === child) this.processes.delete(name); });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
  }

  /** Restart a running profile gateway so Hermes (and its bridge) re-read the allowlist. */
  private async restart(name: string): Promise<void> {
    if (!this.processes.has(name)) return;
    await this.stop(name);
    await this.start(name);
  }

  /**
   * POSIX only: the WhatsApp bridge leads its own session (adapter.py:250-257), so
   * the gateway's process group does not reach it. Kill it through Hermes' pidfile,
   * but only while it is still a child of our gateway (no PID-reuse accidents).
   * On Windows, taskkill /T follows the parent PID and already covers it.
   */
  private async stopBridge(name: string, gatewayPid: number): Promise<void> {
    if (process.platform === 'win32') return;
    let home: string;
    try { ({ home } = this.hermes.channelRuntime(name)); } catch { return; }
    const session = hermesDir(home, 'platforms/whatsapp/session', 'whatsapp/session');
    const pid = Number((await readFile(join(session, 'bridge.pid'), 'utf8').catch(() => '')).split(/\r?\n/)[0]);
    if (!pid) return;
    const parent = Number((await exec('ps', ['-o', 'ppid=', '-p', String(pid)]).catch(() => ({ stdout: '' }))).stdout.trim());
    if (parent === gatewayPid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  }

  private async stop(profile: string): Promise<void> {
    const child = this.processes.get(profile);
    this.processes.delete(profile);
    if (!child?.pid || child.exitCode !== null) return;
    await this.stopBridge(profile, child.pid);
    if (process.platform === 'win32') {
      await exec(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    }
    await Promise.race([
      new Promise<void>((done) => child.once('close', () => done())),
      new Promise<void>((done) => setTimeout(done, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  async resume(): Promise<void> {
    const { profiles } = await this.hermes.listProfiles();
    const whatsapp = await this.whatsappProfiles();
    for (const { name } of profiles) {
      if (!profilePattern.test(name)) continue;
      await this.project(name);
      const enabled = new Set((await this.list(name)).platforms.filter((item) => item.enabled).map((item) => item.id));
      const telegram = !!(await this.vault.get(scope(name), telegramKey)) && enabled.has('telegram');
      if (telegram || (whatsapp[name] && enabled.has('whatsapp'))) await this.start(name);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.detach?.();
    await Promise.allSettled([...this.mutations.values()]);
    await Promise.all([...this.processes.keys()].map((name) => this.stop(name)));
    for (const unbind of this.projections.values()) unbind();
    this.projections.clear();
  }

  health() { return { ok: !this.closing, pid: this.processes.values().next().value?.pid }; }
}

export default defineExtension({
  async activate(ctx) {
    const hermes = ctx.inject<HermesChannels>('agentRuntime');
    const vault = ctx.inject<VaultService>('vault');
    if (!hermes || !vault) throw new Error('Channels require Hermes and Vault services');
    const runtime = new ChannelsRuntime(hermes, vault, {
      bus: ctx.inject<ChannelBus>('channelBus'),
      dataDir: ctx.inject<string>('extensionDataDir'),
      gatewayUrl: ctx.inject<() => string>('gatewayUrl'),
    });
    ctx.effect(() => () => runtime.close());
    await runtime.resume();
    ctx.health(() => runtime.health());
    type Body = Record<string, any>;
    ctx.route('list', ({ body }) => runtime.list((body as Body).profile));
    ctx.route('status', ({ body }) => runtime.status((body as Body).profile));
    ctx.route('connect', ({ body }) => runtime.connect(body as Body as Parameters<ChannelsRuntime['connect']>[0]));
    ctx.route('disconnect', ({ body }) => runtime.disconnect((body as Body).profile, (body as Body).platform));
    ctx.route('senders', ({ body }) => runtime.senders((body as Body).profile));
    ctx.route('allow', ({ body }) => runtime.allow((body as Body).profile, (body as Body).senderId, (body as Body).role));
    ctx.route('revoke', ({ body }) => runtime.revoke((body as Body).profile, (body as Body).senderId));
    ctx.route('approve', ({ body }) => runtime.approve((body as Body).profile, (body as Body).code, (body as Body).role));
  },
});
