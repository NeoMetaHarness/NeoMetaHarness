import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';
import { defineExtension } from '@neometaharness/kernel';
import { HermesProjector, DshProjector, type VaultScope, type VaultService } from '@neometaharness/vault';

const exec = promisify(execFile);
const telegramKey = 'TELEGRAM_BOT_TOKEN';
const profilePattern = /^(default|[a-z][a-z0-9_-]{0,47})$/;

interface HermesChannels {
  channelRuntime(profile: string): { home: string; python: string; upstream: string };
  channelPlatforms(profile: string): Promise<{ platforms: Record<string, unknown>[] }>;
  channelEnabled(profile: string, platform: string, enabled: boolean): Promise<void>;
  listProfiles(): Promise<{ profiles: { name: string }[] }>;
}

function canonical(profile: string): string {
  const name = profile.trim().toLowerCase();
  if (!profilePattern.test(name)) throw new Error('Invalid channel profile');
  return name;
}

function scope(profile: string): VaultScope {
  return { kind: 'engine', workspaceId: 'default', subjectId: `engine-hermes/${canonical(profile)}` };
}

function platformMetadata(raw: Record<string, unknown>) {
  return {
    id: String(raw.id ?? ''), name: String(raw.name ?? ''),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    enabled: raw.enabled === true, configured: raw.configured === true,
    gatewayRunning: raw.gateway_running === true,
    ...(typeof raw.error_message === 'string' && raw.error_message ? { error: raw.error_message } : {}),
  };
}

/** Platform configuration stays in Hermes. The vault is the sole owner of its token. */
export class ChannelsRuntime {
  private readonly processes = new Map<string, ChildProcess>();
  private readonly projections = new Map<string, () => void>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private closing = false;

  constructor(private readonly hermes: HermesChannels, private readonly vault: VaultService) {}

  private async serialize<T>(profile: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(profile) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.mutations.set(profile, current);
    try { return await current; }
    finally {
      if (this.mutations.get(profile) === current) this.mutations.delete(profile);
    }
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
    const child = this.processes.get(name);
    return { platforms: result.platforms.map((item) => item.id === 'telegram'
      ? { ...item, configured, gatewayRunning: !!child && child.exitCode === null }
      : item) };
  }

  async connect(profile: string, platform: 'telegram', token: string) {
    const name = canonical(profile);
    return this.serialize(name, async () => {
      if (this.closing) throw new Error('Channels disabled');
      if (platform !== 'telegram') throw new Error('Platform is not supported in the first Channels slice');
      if (!/^\d{5,20}:[A-Za-z0-9_-]{4,}$/.test(token)) throw new Error('Invalid Telegram bot token');
      if (!(await this.list(name)).platforms.some((item) => item.id === platform)) {
        throw new Error('Hermes does not expose this platform');
      }
      await this.project(name);
      // A reconnect rotates the secret and tears down the old gateway before launching it again.
      await this.stop(name);
      await this.vault.put(scope(name), telegramKey, token);
      await this.hermes.channelEnabled(name, platform, true);
      await this.start(name);
      return { connected: this.processes.get(name)?.exitCode === null };
    });
  }

  async disconnect(profile: string, platform: 'telegram') {
    const name = canonical(profile);
    return this.serialize(name, async () => {
      if (this.closing) throw new Error('Channels disabled');
      if (platform !== 'telegram') throw new Error('Unsupported channel');
      await this.project(name);
      await this.stop(name);
      await this.hermes.channelEnabled(name, platform, false);
      await this.vault.delete(scope(name), telegramKey);
      return { disconnected: true };
    });
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

  private async start(profile: string): Promise<void> {
    if (this.closing) return;
    const name = canonical(profile);
    const { home, python, upstream } = this.hermes.channelRuntime(name);
    const token = await this.vault.get(scope(name), telegramKey);
    if (!token) return;
    await this.configureStandin(home);
    const safeEnv = await new DshProjector([telegramKey]).project(new Map([[telegramKey, token]]));
    // Standard gateway boot applies Hermes' env and plugin platform overrides.
    // --config constructs GatewayConfig.from_dict directly, leaving env-sourced bot tokens unset.
    const child = spawn(python, ['-u', '-m', 'gateway.run'], {
      cwd: upstream, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore',
      env: {
        ...safeEnv, HERMES_HOME: home, PYTHONPATH: upstream, PYTHONDONTWRITEBYTECODE: '1',
        HERMES_DISABLE_LAZY_INSTALLS: '1',
        HERMES_TELEGRAM_DISABLE_FALLBACK_IPS: '1',
        HERMES_TELEGRAM_TEXT_BATCH_DELAY_SECONDS: '0',
        HERMES_TELEGRAM_TEXT_BATCH_SPLIT_DELAY_SECONDS: '0',
        ...(process.env.NMH_CHANNELS_TELEGRAM_API_BASE ? { TELEGRAM_ALLOWED_USERS: '111', TELEGRAM_HOME_CHANNEL: '111' } : {}),
      },
    });
    this.processes.set(name, child);
    child.once('exit', () => { if (this.processes.get(name) === child) this.processes.delete(name); });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
  }

  private async stop(profile: string): Promise<void> {
    const child = this.processes.get(profile);
    this.processes.delete(profile);
    if (!child?.pid || child.exitCode !== null) return;
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
    for (const { name } of profiles) {
      if (!profilePattern.test(name)) continue;
      await this.project(name);
      const available = await this.vault.get(scope(name), telegramKey);
      if (available && (await this.list(name)).platforms.some((item) => item.id === 'telegram' && item.enabled)) {
        await this.start(name);
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
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
    const runtime = new ChannelsRuntime(hermes, vault);
    await runtime.resume();
    ctx.effect(() => () => runtime.close());
    ctx.health(() => runtime.health());
    ctx.route('list', ({ body }) => runtime.list((body as { profile: string }).profile));
    ctx.route('status', ({ body }) => runtime.status((body as { profile: string }).profile));
    ctx.route('connect', ({ body }) => {
      const { profile, platform, token } = body as { profile: string; platform: 'telegram'; token: string };
      return runtime.connect(profile, platform, token);
    });
    ctx.route('disconnect', ({ body }) => {
      const { profile, platform } = body as { profile: string; platform: 'telegram' };
      return runtime.disconnect(profile, platform);
    });
  },
});
