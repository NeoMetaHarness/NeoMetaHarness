import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, linkSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RPCHandler as WSRPCHandler } from '@orpc/server/ws';
import { RPCHandler as HttpRPCHandler } from '@orpc/server/node';
import { implement, ORPCError } from '@orpc/server';
import {
  computerActionSchema,
  neoContract,
  type T3Event,
  type HermesEvent,
  type DshEvent,
  type VaultOperation,
  type InboxItem,
  type InboxEvent,
  type RegistrySkill,
  type ModelProviderRecord,
  type ModelSelectionRecord,
  type ModelRolesRecord,
  type ModelRoleName,
} from '@neometaharness/contracts';
import {
  VaultService,
  KeyFileProvider,
  restrictPrivatePath,
  type KeyProvider,
  type VaultScope,
} from '@neometaharness/vault';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { NeoKernel, SkillsBridge } from '@neometaharness/kernel';
import { ComputerRegistry } from '@neometaharness/computers';
import {
  createNeoAuth,
  migrateAuthSchema,
  bootstrapDesktopAuth,
  resolveAuthContext,
  type NeoAuth,
} from '@neometaharness/auth';
import { toNodeHandler } from 'better-auth/node';
import { coalesceText } from './coalesce.js';
import { createAgentGateway } from './agents.js';
import {
  requireViewer,
  requireMember,
  requireAdminOrOwner,
  requireOwner,
  type GatewayAuthContext,
} from './rbac.js';
import {
  authorize,
  getPolicy,
  ROUTE_POLICY,
  CONTRACT_POLICY,
  policyMiddleware,
  HTTP_ROUTE_POLICY,
  type PolicyLevel,
} from './policy.js';

export {
  requireViewer,
  requireMember,
  requireAdminOrOwner,
  requireOwner,
  authorize,
  getPolicy,
  ROUTE_POLICY,
  CONTRACT_POLICY,
  policyMiddleware,
  HTTP_ROUTE_POLICY,
  type GatewayAuthContext,
  type PolicyLevel,
};

export interface GatewayOptions {
  databaseFile: string;
  dataDir?: string;
  extensionsDir?: string;
  port?: number;
  mode?: 'server' | 'desktop';
  secret?: string;
  vaultKeyFile?: string;
  vaultKeyProvider?: KeyProvider;
  authorizeVault?: (operation: VaultOperation, scope: VaultScope) => boolean | Promise<boolean>;
  /**
   * Server-mode HTTP sign-up. 'invite' (default; NEO_SIGNUP overrides): the first
   * account needs the one-time setup token, later ones a pending invitation.
   * 'open': anyone may register (roleless until invited).
   */
  signup?: 'invite' | 'open';
}

export interface GatewayInstance {
  port: number;
  kernel: NeoKernel;
  vault: VaultService;
  computers: ComputerRegistry;
  desktopToken?: string;
  /** Present in invite-mode server instances until the first account exists. */
  setupToken?: string;
  auth: NeoAuth;
  db: SqliteDatabaseProvider;
  router?: any;
  close(): Promise<void>;
}

const defaultExtensions = fileURLToPath(new URL('../../../extensions/', import.meta.url));

/** Browser origins allowed to call the gateway: loopback dev shells and the Tauri webview. */
const ALLOWED_ORIGIN = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?|https?:\/\/tauri\.localhost|tauri:\/\/localhost)$/;

/**
 * DNS-rebinding and cross-site guard shared by HTTP and WS. The gateway only
 * listens on loopback, so a Host naming anything else means a browser was
 * pointed here through a rebound hostname. A present Origin must be one of
 * the app's own origins (Better Auth's CSRF check is disabled). Extra hosts,
 * e.g. behind a reverse proxy, come from NEO_ALLOWED_HOSTS (comma separated).
 */
function refuseRequest(headers: { host?: string; origin?: string }, port: number): 421 | 403 | undefined {
  const extra = (process.env.NEO_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = (headers.host ?? '').toLowerCase();
  const loopback = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!loopback.includes(host) && !extra.includes(host)) return 421;
  if (headers.origin && !ALLOWED_ORIGIN.test(headers.origin)
    && !extra.some((h) => headers.origin === `https://${h}` || headers.origin === `http://${h}`)) return 403;
  return undefined;
}

function resolveOrGenerateSecret(dataDir: string, explicitSecret?: string): string {
  if (explicitSecret) return explicitSecret;
  const secretPath = join(dataDir, 'auth.secret');
  if (existsSync(secretPath)) {
    const val = readFileSync(secretPath, 'utf8').trim();
    if (val.length >= 32) return val;
    throw new Error('Auth secret in file is too short');
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  const tmpPath = `${secretPath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, secret, { encoding: 'utf8', mode: 0o600 });
  try {
    linkSync(tmpPath, secretPath);
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
  return readFileSync(secretPath, 'utf8').trim();
}

export async function startGateway(options: GatewayOptions): Promise<GatewayInstance> {
  const mode = options.mode ?? 'server';
  const db = new SqliteDatabaseProvider(options.databaseFile);
  const dataDir = options.dataDir ?? (options.databaseFile !== ':memory:' ? dirname(resolve(options.databaseFile)) : process.cwd());
  const authSecret = resolveOrGenerateSecret(
    dataDir,
    options.secret ?? process.env.BETTER_AUTH_SECRET ?? process.env.NEO_AUTH_SECRET,
  );

  const signupMode = options.signup ?? (process.env.NEO_SIGNUP === 'open' ? 'open' : 'invite');
  let setupToken: string | undefined;
  const setupTokenFile = join(dataDir, 'setup.token');
  const kyselyDb = db.kysely as any;
  const auth = createNeoAuth({
    db: db.kysely,
    baseURL: 'http://127.0.0.1:0',
    secret: authSecret,
    signUpGate: mode === 'server' && signupMode === 'invite' ? async ({ email, headers }) => {
      const anyUser = await kyselyDb.selectFrom('user').select('id').executeTakeFirst();
      if (!anyUser) {
        const provided = headers.get('x-neo-setup-token') ?? '';
        return Boolean(setupToken && /^[0-9a-f]{64}$/.test(provided)
          && timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(setupToken, 'hex')));
      }
      if (setupToken) {
        setupToken = undefined;
        try { unlinkSync(setupTokenFile); } catch { /* already gone */ }
      }
      const invitation = await kyselyDb.selectFrom('invitation').select(['id', 'expiresAt'])
        .where('email', '=', email).where('status', '=', 'pending').execute() as { expiresAt: string | Date }[];
      return invitation.some((row) => new Date(row.expiresAt).getTime() > Date.now());
    } : undefined,
  });
  await migrateAuthSchema(auth);
  if (mode === 'server' && signupMode === 'invite'
    && !(await kyselyDb.selectFrom('user').select('id').executeTakeFirst())) {
    // A one-time token closes the "first caller becomes instance owner" race.
    setupToken = randomBytes(32).toString('hex');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(setupTokenFile, setupToken, { encoding: 'utf8', mode: 0o600 });
    await restrictPrivatePath(setupTokenFile);
  }

  let desktopToken: string | undefined;
  if (mode === 'desktop') {
    const desktop = await bootstrapDesktopAuth(auth, { dataDir });
    desktopToken = desktop.token;
  }

  const authNodeHandler = toNodeHandler(auth);

  const vault = new VaultService(db, options.vaultKeyProvider ?? new KeyFileProvider(
    options.vaultKeyFile ?? join(dirname(resolve(options.databaseFile)), 'vault-keys', 'master.key'),
  ));

  let gatewayPort = 0;
  const computers = new ComputerRegistry(
    () => {
      if (!gatewayPort) throw new Error('Computer Gateway is not listening');
      return `http://127.0.0.1:${gatewayPort}/internal/computers/action`;
    },
    (notice) => kernel.events.publishComputer(notice),
  );

  // Bind each engine consumer to its own vault scope and workspace. The profile
  // argument is taken from the engine runtime, never trusted from the HTTP caller.
  type MemoryConsumer = { engine: 'hermes' | 'dsh'; profile: string; workspace: string };
  const memoryConsumers = new Map<string, MemoryConsumer>();
  const memoryKey = (engine: 'hermes' | 'dsh', profile: string) => `${engine}:${profile}`;
  const memoryScope = ({ engine, profile, workspace }: MemoryConsumer) => ({
    kind: 'engine' as const, workspaceId: workspace, subjectId: `engine-${engine}/${profile}`,
  });
  const issueMemoryBinding = async (consumer: MemoryConsumer) => {
    if (!gatewayPort || !kernel.hasRoute('/x/memory-local/list')) return undefined;
    const scope = memoryScope(consumer);
    let token = await vault.get(scope, 'NEO_MEMORY_TOKEN');
    if (!token) {
      token = randomBytes(32).toString('hex');
      await vault.put(scope, 'NEO_MEMORY_TOKEN', token);
    }
    memoryConsumers.set(memoryKey(consumer.engine, consumer.profile), consumer);
    return { endpoint: `http://127.0.0.1:${gatewayPort}/internal/memory`, token, profile: consumer.profile };
  };
  const memoryBridge = {
    async binding(profile: string, workspaceId?: string) {
      // Existing desktop Hermes profiles predate workspace ownership; future
      // workspace-aware callers can supply their owning workspace explicitly.
      return issueMemoryBinding({ engine: 'hermes', profile, workspace: workspaceId ?? 'default' });
    },
  };
  const dshMemoryBridge = {
    binding(sessionId: string, workspaceId: string) {
      return issueMemoryBinding({ engine: 'dsh', profile: sessionId, workspace: workspaceId });
    },
    forget(sessionId: string) { memoryConsumers.delete(memoryKey('dsh', sessionId)); },
  };
  const skillsBridge = new SkillsBridge();
  const kernel = new NeoKernel(db, {
    computers,
    vault,
    auth,
    memoryRecords: (db as any).memories,
    memoryBridge,
    dshMemoryBridge,
    skillsBridge,
    extensionDataDir: join(dirname(resolve(options.databaseFile)), 'extensions'),
    gatewayUrl: () => `http://127.0.0.1:${gatewayPort}`,
  });

  const authorizeVault = async (operation: VaultOperation, scope: VaultScope, context?: GatewayAuthContext) => {
    authorize(`vault.${operation}`, context);
    if (scope?.workspaceId && scope.workspaceId !== context?.workspaceId) {
      // Cross-workspace access needs a sufficient role in the target workspace
      // itself. Scope ids that are not Neo workspaces (the legacy 'default'
      // scope, engine tenants) belong to the instance: only an owner of the
      // bootstrap workspace, and the operator's authorizeVault hook still applies.
      const kysely = auth.kysely;
      const userId = context?.user?.id;
      let held: string | undefined;
      if (kysely && userId) {
        const memberRole = async (organizationId: string) => (await kysely.selectFrom('member').select('role')
          .where('userId', '=', userId).where('organizationId', '=', organizationId)
          .executeTakeFirst() as { role: string } | undefined)?.role;
        const target = await kysely.selectFrom('organization').select('id')
          .where('id', '=', scope.workspaceId).executeTakeFirst();
        if (target) {
          held = await memberRole(scope.workspaceId);
        } else {
          const bootstrap = await kysely.selectFrom('organization').select('id')
            .orderBy('createdAt').executeTakeFirst() as { id: string } | undefined;
          held = bootstrap && (await memberRole(bootstrap.id)) === 'owner' ? 'owner' : undefined;
        }
      }
      if (!held) throw new ORPCError('FORBIDDEN', { message: 'Cross-workspace vault access forbidden' });
      authorize(`vault.${operation}`, { ...context!, workspaceId: scope.workspaceId, role: held as GatewayAuthContext['role'] });
    }
    if (options.authorizeVault && (await options.authorizeVault(operation, scope)) !== true) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Vault access denied' });
    }
  };

  try {
    await kernel.discover(resolve(options.extensionsDir ?? defaultExtensions));
  } catch (error) {
    await kernel.close();
    throw error;
  }

  const agentApi = await createAgentGateway(db, kernel);
  const os = implement(neoContract).$context<GatewayAuthContext>().use(policyMiddleware as any);

  const invokeT3 = async (route: string, body: unknown) => {
    const path = `/x/engine-t3/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'T3 extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeHermes = async (route: string, body: unknown) => {
    const path = `/x/engine-hermes/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Hermes extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeChannels = async (route: string, body: unknown) => {
    const path = `/x/channels/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Channels extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeDsh = async (route: string, body: unknown) => {
    const path = `/x/engine-dsh/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'DSH extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeInbox = async (route: string, body: unknown) => {
    const path = `/x/engine-superagent/${route}`;
    if (!kernel.hasRoute(path)) {
      throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Superagent extension is disabled' });
    }
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeMemory = async (route: string, body: unknown) => {
    const path = `/x/memory-local/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Local memory extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeHoncho = async (route: string, body: unknown) => {
    const path = '/x/memory-honcho/' + route;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Honcho extension disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const writeHonchoWithRetry = async (input: {
    workspace: string; subjectId: string; session: string; user: string; assistant: string;
  }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!kernel.hasRoute('/x/memory-honcho/turn')) return;
      try { await invokeHoncho('turn', input); return; }
      catch {
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  };
  const invokeSkills = async (route: string, body: unknown) => {
    const path = `/x/skills-registry/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Skill registry extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeModels = async (route: string, body: unknown) => {
    const path = `/x/models/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Model Hub extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  type SkillRecord = RegistrySkill;
  const withHealth = async (id: string) => {
    const health = await kernel.health(id).catch(() => ({ ok: false }));
    return { ...kernel.status(id), ...(health ? { health } : {}) };
  };

  const router = {
    agents: agentApi.router,
    inbox: {
      ask: os.inbox.ask.handler(async ({ input, context }) => {
        authorize('inbox.ask', context);
        return invokeInbox('ask', { ...input, requesterRole: context.role, requesterId: context.user?.id }) as Promise<InboxItem>;
      }),
      list: os.inbox.list.handler(async ({ context }) => {
        authorize('inbox.list', context);
        return invokeInbox('list', {}) as Promise<InboxItem[]>;
      }),
      decisions: {
        list: os.inbox.decisions.list.handler(async ({ input, context }) => {
          authorize('inbox.decisions.list', context);
          return invokeInbox('decisions/list', input) as Promise<import('@neometaharness/contracts').InboxDecision[]>;
        }),
      },
      accept: os.inbox.accept.handler(async ({ input, context }) => {
        authorize('inbox.accept', context);
        return invokeInbox('accept', input) as Promise<InboxItem>;
      }),
      reply: os.inbox.reply.handler(async ({ input, context }) => {
        authorize('inbox.reply', context);
        return invokeInbox('reply', input) as Promise<InboxItem>;
      }),
      approval: { decide: os.inbox.approval.decide.handler(async ({ input, context }) => {
        authorize('inbox.approval.decide', context);
        const items = await invokeInbox('list', {}) as InboxItem[];
        const item = items.find((entry) => entry.id === input.id);
        if (item?.approval?.destructive && context.role !== 'admin' && context.role !== 'owner') {
          throw new ORPCError('FORBIDDEN', { message: 'Destructive approval requires admin or owner' });
        }
        return invokeInbox('approval/decide', { ...input, role: context.role }) as Promise<InboxItem>;
      }) },
      retry: os.inbox.retry.handler(async ({ input, context }) => {
        authorize('inbox.retry', context);
        return invokeInbox('retry', input) as Promise<InboxItem>;
      }),
      upstream: { check: os.inbox.upstream.check.handler(async ({ context }) => {
        authorize('inbox.upstream.check', context);
        return invokeInbox('upstream/check', {}) as Promise<{ checked: number; drift: number }>;
      }) },
      events: os.inbox.events.handler(async function* ({ input, signal, context }) {
        authorize('inbox.events', context);
        const stream = await invokeInbox('events', { ...input, signal }) as AsyncIterable<InboxEvent>;
        yield* stream;
      }),
      cron: {
        create: os.inbox.cron.create.handler(async ({ input, context }) => {
          authorize('inbox.cron.create', context);
          return invokeInbox('cron/create', { ...input, requesterRole: context.role }) as Promise<{ id: string; text: string; botId: string; schedule: string; mode: 'observe' | 'act' }>;
        }),
        list: os.inbox.cron.list.handler(async ({ context }) => {
          authorize('inbox.cron.list', context);
          return invokeInbox('cron/list', {}) as Promise<{ id: string; text: string; botId: string; schedule: string; mode: 'observe' | 'act' }[]>;
        }),
        delete: os.inbox.cron.delete.handler(async ({ input, context }) => {
          authorize('inbox.cron.delete', context);
          return invokeInbox('cron/delete', input) as Promise<{ deleted: boolean }>;
        }),
        fire: os.inbox.cron.fire.handler(async ({ input, context }) => {
          authorize('inbox.cron.fire', context);
          if (process.env.NODE_ENV !== 'test') throw new ORPCError('NOT_FOUND');
          return invokeInbox('cron/fire', input) as Promise<{ ok: boolean }>;
        }),
      },
      channel: {
        emit: os.inbox.channel.emit.handler(async ({ input, context }) => {
          authorize('inbox.channel.emit', context);
          if (process.env.NODE_ENV !== 'test') throw new ORPCError('NOT_FOUND');
          return invokeInbox('channel/emit', input) as Promise<{ ok: boolean }>;
        }),
        replies: os.inbox.channel.replies.handler(async ({ context }) => {
          authorize('inbox.channel.replies', context);
          if (process.env.NODE_ENV !== 'test') throw new ORPCError('NOT_FOUND');
          return invokeInbox('channel/replies', {}) as Promise<{ channelId: string; inReplyTo: string; text: string }[]>;
        }),
      },
    },
    x: {
      models: {
        providers: {
          list: os.x.models.providers.list.handler(async ({ context }) => {
            requireViewer(context);
            return invokeModels('providers/list', {}) as Promise<ModelProviderRecord[]>;
          }),
          put: os.x.models.providers.put.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('providers/put', input) as Promise<ModelProviderRecord>;
          }),
          delete: os.x.models.providers.delete.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('providers/delete', input) as Promise<{ deleted: boolean }>;
          }),
          test: os.x.models.providers.test.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('providers/test', input) as Promise<{ ok: boolean; models: number; status: number }>;
          }),
        },
        roles: {
          get: os.x.models.roles.get.handler(async ({ context }) => {
            requireViewer(context);
            return invokeModels('roles/get', {}) as Promise<ModelRolesRecord>;
          }),
          set: os.x.models.roles.set.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('roles/set', input) as Promise<{ role: ModelRoleName; selection: ModelSelectionRecord }>;
          }),
        },
        override: {
          get: os.x.models.override.get.handler(async ({ input, context }) => {
            requireViewer(context);
            return invokeModels('override/get', input) as Promise<{ profile: string; selection: ModelSelectionRecord | null }>;
          }),
          set: os.x.models.override.set.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('override/set', input) as Promise<{ profile: string; selection: ModelSelectionRecord | null }>;
          }),
        },
      },
      channels: {
        list: os.x.channels.list.handler(async ({ input, context }) => {
          requireViewer(context);
          return invokeChannels('list', input) as Promise<any>;
        }),
        connect: os.x.channels.connect.handler(async ({ input, context }) => {
          requireAdminOrOwner(context);
          return invokeChannels('connect', input) as Promise<{ connected: boolean }>;
        }),
        disconnect: os.x.channels.disconnect.handler(async ({ input, context }) => {
          requireAdminOrOwner(context);
          return invokeChannels('disconnect', input) as Promise<{ disconnected: boolean }>;
        }),
        status: os.x.channels.status.handler(async ({ input, context }) => {
          requireViewer(context);
          return invokeChannels('status', input) as Promise<any>;
        }),
      },
      'skills-registry': {
        list: os.x['skills-registry'].list.handler(async ({ context }) => {
          authorize('x.skills-registry.list', context);
          return invokeSkills('list', {}) as Promise<SkillRecord[]>;
        }),
        get: os.x['skills-registry'].get.handler(async ({ input, context }) => {
          authorize('x.skills-registry.get', context);
          return invokeSkills('get', input) as Promise<{ metadata: SkillRecord; content: string }>;
        }),
        import: os.x['skills-registry'].import.handler(async ({ input, context }) => {
          authorize('x.skills-registry.import', context);
          return invokeSkills('import', input) as Promise<SkillRecord>;
        }),
        sync: os.x['skills-registry'].sync.handler(async ({ input, context }) => {
          authorize('x.skills-registry.sync', context);
          return invokeSkills('sync', input) as Promise<SkillRecord[]>;
        }),
        versions: os.x['skills-registry'].versions.handler(async ({ input, context }) => {
          authorize('x.skills-registry.versions', context);
          return invokeSkills('versions', input) as Promise<{ version: number; hash: string; metadata: SkillRecord }[]>;
        }),
        diff: os.x['skills-registry'].diff.handler(async ({ input, context }) => {
          authorize('x.skills-registry.diff', context);
          return invokeSkills('diff', input) as Promise<{ diff: string }>;
        }),
        rollback: os.x['skills-registry'].rollback.handler(async ({ input, context }) => {
          authorize('x.skills-registry.rollback', context);
          return invokeSkills('rollback', input) as Promise<SkillRecord>;
        }),
        assign: os.x['skills-registry'].assign.handler(async ({ input, context }) => {
          authorize('x.skills-registry.assign', context);
          return invokeSkills('assign', input) as Promise<{ assigned: boolean }>;
        }),
        assignments: os.x['skills-registry'].assignments.handler(async ({ context }) => {
          authorize('x.skills-registry.assignments', context);
          return invokeSkills('assignments', {}) as Promise<{ name: string; engine: 'hermes' | 'dsh'; targetId: string }[]>;
        }),
        checks: {
          set: os.x['skills-registry'].checks.set.handler(async ({ input, context }) => {
            authorize('x.skills-registry.checks.set', context);
            return invokeSkills('checks/set', { ...input, actor: context.user!.id }) as Promise<SkillRecord>;
          }),
        },
        autonomy: {
          set: os.x['skills-registry'].autonomy.set.handler(async ({ input, context }) => {
            authorize('x.skills-registry.autonomy.set', context);
            return invokeSkills('autonomy/set', { ...input, actor: context.user!.id }) as Promise<SkillRecord>;
          }),
        },
        evaluate: os.x['skills-registry'].evaluate.handler(async ({ input, context }) => {
          authorize('x.skills-registry.evaluate', context);
          return invokeSkills('evaluate', input) as Promise<{ status: 'passed' | 'failed' | 'unevaluated' | 'overridden'; version: number }>;
        }),
        override: os.x['skills-registry'].override.handler(async ({ input, context }) => {
          authorize('x.skills-registry.override', context);
          return invokeSkills('override', { ...input, actor: context.user!.id }) as Promise<{ status: 'overridden'; version: number }>;
        }),
        ceiling: {
          get: os.x['skills-registry'].ceiling.get.handler(async ({ input, context }) => {
            authorize('x.skills-registry.ceiling.get', context);
            return invokeSkills('ceiling', input) as Promise<{ ceiling: 'suggest' | 'auto-low' | 'auto' }>;
          }),
          set: os.x['skills-registry'].ceiling.set.handler(async ({ input, context }) => {
            authorize('x.skills-registry.ceiling.set', context);
            return invokeSkills('ceiling/set', input) as Promise<{ ceiling: 'suggest' | 'auto-low' | 'auto' }>;
          }),
        },
        hub: {
          scan: os.x['skills-registry'].hub.scan.handler(async ({ input, context }) => {
            authorize('x.skills-registry.hub.scan', context);
            // The registry scans only the bytes returned by this single preview fetch.
            // Hub bundles with non-previewed files are rejected by inspectHub.
            const preview = await invokeHermes('skills/preview', input);
            return invokeSkills('hub/scan', { ...input, preview, upstream: { policy: 'allow' } }) as Promise<any>;
          }),
          approve: os.x['skills-registry'].hub.approve.handler(async ({ input, context }) => {
            authorize('x.skills-registry.hub.approve', context);
            return invokeSkills('hub/approve', { ...input, actor: context.user!.id }) as Promise<any>;
          }),
          install: os.x['skills-registry'].hub.install.handler(async ({ input, context }) => {
            authorize('x.skills-registry.hub.install', context);
            const preview = await invokeHermes('skills/preview', input);
            return invokeSkills('hub/install', { ...input, preview, upstream: { policy: 'allow' } }) as Promise<SkillRecord>;
          }),
        },
      },
      'memory-honcho': {
        status: os.x['memory-honcho'].status.handler(async ({ input, context }) => {
          authorize('x.memory-honcho.status', context);
          if (!kernel.hasRoute('/x/memory-honcho/status')) return 'off';
          return invokeHoncho('status', input) as Promise<'ok' | 'degraded' | 'off'>;
        }),
        list: os.x['memory-honcho'].list.handler(async ({ input, context }) => {
          authorize('x.memory-honcho.list', context);
          if (!kernel.hasRoute('/x/memory-honcho/list')) return [];
          return invokeHoncho('list', input) as ReturnType<typeof db.memories.list>;
        }),
      },
      'memory-local': {
        list: os.x['memory-local'].list.handler(async ({ input, context }) => {
          authorize('x.memory-local.list', context);
          return invokeMemory('list', input) as ReturnType<typeof db.memories.list>;
        }),
        add: os.x['memory-local'].add.handler(async ({ input, context }) => {
          authorize('x.memory-local.add', context);
          return invokeMemory('add', input) as ReturnType<typeof db.memories.add>;
        }),
        update: os.x['memory-local'].update.handler(async ({ input, context }) => {
          authorize('x.memory-local.update', context);
          return (await invokeMemory('update', input) as Awaited<ReturnType<typeof db.memories.update>>) ?? null;
        }),
        delete: os.x['memory-local'].delete.handler(async ({ input, context }) => {
          authorize('x.memory-local.delete', context);
          return invokeMemory('delete', input) as Promise<{ deleted: boolean }>;
        }),
        export: os.x['memory-local'].export.handler(async ({ input, context }) => {
          authorize('x.memory-local.export', context);
          return invokeMemory('export', input) as ReturnType<typeof db.memories.export>;
        }),
      },
      'engine-dsh': {
        create: os.x['engine-dsh'].create.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.create', context);
          return invokeDsh('create', input) as Promise<{ sessionId: string; pid: number }>;
        }),
        prompt: os.x['engine-dsh'].prompt.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.prompt', context);
          return invokeDsh('prompt', input) as Promise<{ messageId: string }>;
        }),
        events: os.x['engine-dsh'].events.handler(async function* ({ input, signal, context }) {
          authorize('x.engine-dsh.events', context);
          const stream = await invokeDsh('events', { ...input, signal }) as AsyncIterable<DshEvent>;
          yield* coalesceText(stream);
        }),
        wait: os.x['engine-dsh'].wait.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.wait', context);
          return invokeDsh('wait', input) as Promise<{ status: 'settled' }>;
        }),
        cancel: os.x['engine-dsh'].cancel.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.cancel', context);
          return invokeDsh('cancel', input) as Promise<{ cancelled: boolean }>;
        }),
        shutdown: os.x['engine-dsh'].shutdown.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.shutdown', context);
          return invokeDsh('shutdown', input) as Promise<{ stopped: boolean }>;
        }),
      },
      'engine-t3': {
        create: os.x['engine-t3'].create.handler(async ({ input, context }) => {
          authorize('x.engine-t3.create', context);
          return invokeT3('create', input) as Promise<{ sequence: number }>;
        }),
        send: os.x['engine-t3'].send.handler(async ({ input, context }) => {
          authorize('x.engine-t3.send', context);
          return invokeT3('send', input) as Promise<{ sequence: number }>;
        }),
        events: os.x['engine-t3'].events.handler(async function* ({ input, signal, context }) {
          authorize('x.engine-t3.events', context);
          const stream = await invokeT3('events', { ...input, signal }) as AsyncIterable<T3Event>;
          yield* coalesceText(stream);
        }),
        approval: os.x['engine-t3'].approval.handler(async ({ input, context }) => {
          authorize('x.engine-t3.approval', context);
          return invokeT3('approval', input) as Promise<{ sequence: number }>;
        }),
        settle: os.x['engine-t3'].settle.handler(async ({ input, context }) => {
          authorize('x.engine-t3.settle', context);
          return invokeT3('settle', input) as Promise<{ sequence: number }>;
        }),
        stop: os.x['engine-t3'].stop.handler(async ({ input, context }) => {
          authorize('x.engine-t3.stop', context);
          return invokeT3('stop', input) as Promise<{ outcome: 'killed' | 'released' | 'releasing' | 'shared'; sharedWithThreadIds: string[] }>;
        }),
        diff: os.x['engine-t3'].diff.handler(async ({ input, context }) => {
          authorize('x.engine-t3.diff', context);
          return invokeT3('diff', input) as Promise<{ threadId: string; fromTurnCount: number; toTurnCount: number; diff: string }>;
        }),
        rollback: os.x['engine-t3'].rollback.handler(async ({ input, context }) => {
          authorize('x.engine-t3.rollback', context);
          return invokeT3('rollback', input) as Promise<{ sequence: number }>;
        }),
        providers: {
          list: os.x['engine-t3'].providers.list.handler(async ({ context }) => {
            authorize('x.engine-t3.providers.list', context);
            return invokeT3('providers/list', {}) as Promise<{ providers: {
              id: string; name: string; status: string;
              models: { id: string; name: string; isDefault: boolean }[];
            }[] }>;
          }),
        },
        threads: {
          list: os.x['engine-t3'].threads.list.handler(async ({ context }) => {
            authorize('x.engine-t3.threads.list', context);
            return invokeT3('threads/list', {}) as Promise<any>;
          }),
        },
      },
      'engine-hermes': {
        skills: {
          list: os.x['engine-hermes'].skills.list.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.list', context);
            return invokeHermes('skills/list', input) as Promise<{ name: string; provenance?: string; usage?: number }[]>;
          }),
          hub: os.x['engine-hermes'].skills.hub.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.hub', context);
            return invokeHermes('skills/hub', input) as Promise<{ skills: { name: string }[] }>;
          }),
          preview: os.x['engine-hermes'].skills.preview.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.preview', context);
            return invokeHermes('skills/preview', input) as Promise<{ name: string; identifier: string; skill_md: string; files: string[] }>;
          }),
          scan: os.x['engine-hermes'].skills.scan.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.scan', context);
            return invokeHermes('skills/scan', input) as Promise<{ policy: string; findings: unknown[] }>;
          }),
          curator: os.x['engine-hermes'].skills.curator.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.curator', context);
            return invokeHermes('skills/curator', input) as Promise<{ enabled: boolean; paused: boolean }>;
          }),
          pause: os.x['engine-hermes'].skills.pause.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.pause', context);
            return invokeHermes('skills/pause', input) as Promise<{ ok: boolean; paused: boolean }>;
          }),
          run: os.x['engine-hermes'].skills.run.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.run', context);
            return invokeHermes('skills/run', input) as Promise<{ ok: boolean; pid: number; name: string }>;
          }),
          graph: os.x['engine-hermes'].skills.graph.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.graph', context);
            return invokeHermes('skills/graph', input) as Promise<{ nodes: { id: string; label: string; kind: string }[]; edges: { source: string; target: string }[] }>;
          }),
          learn: os.x['engine-hermes'].skills.learn.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.skills.learn', context);
            return invokeHermes('skills/learn', input) as Promise<{ run_id: string }>;
          }),
        },
        profiles: {
          list: os.x['engine-hermes'].profiles.list.handler(async ({ context }) => {
            authorize('x.engine-hermes.profiles.list', context);
            return invokeHermes('profiles/list', {}) as Promise<{ profiles: { name: string; path: string }[] }>;
          }),
          create: os.x['engine-hermes'].profiles.create.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.profiles.create', context);
            return invokeHermes('profiles/create', input) as Promise<{ ok: boolean; name: string; path: string }>;
          }),
          delete: os.x['engine-hermes'].profiles.delete.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.profiles.delete', context);
            return invokeHermes('profiles/delete', input);
          }),
        },
        runs: {
          start: os.x['engine-hermes'].runs.start.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.runs.start', context);
            return invokeHermes('runs/start', input) as Promise<{ run_id: string }>;
          }),
          events: os.x['engine-hermes'].runs.events.handler(async function* ({ input, signal, context }) {
            authorize('x.engine-hermes.runs.events', context);
            const stream = await invokeHermes('runs/events', { ...input, signal }) as AsyncIterable<HermesEvent>;
            yield* coalesceText(stream);
          }),
          approve: os.x['engine-hermes'].runs.approve.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.runs.approve', context);
            return invokeHermes('runs/approve', input) as Promise<{ ok: boolean }>;
          }),
          stop: os.x['engine-hermes'].runs.stop.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.runs.stop', context);
            return invokeHermes('runs/stop', input) as Promise<{ status: string }>;
          }),
        },
        cron: {
          list: os.x['engine-hermes'].cron.list.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.cron.list', context);
            return invokeHermes('cron/list', input ?? {}) as Promise<Record<string, unknown>[]>;
          }),
          create: os.x['engine-hermes'].cron.create.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.cron.create', context);
            return invokeHermes('cron/create', input) as Promise<{ id: string }>;
          }),
          update: os.x['engine-hermes'].cron.update.handler(async ({ input, context }) => {
            requireMember(context);
            return invokeHermes('cron/update', input) as Promise<Record<string, unknown>>;
          }),
          pause: os.x['engine-hermes'].cron.pause.handler(async ({ input, context }) => {
            requireMember(context);
            return invokeHermes('cron/pause', input) as Promise<Record<string, unknown>>;
          }),
          trigger: os.x['engine-hermes'].cron.trigger.handler(async ({ input, context }) => {
            requireMember(context);
            return invokeHermes('cron/trigger', input) as Promise<Record<string, unknown>>;
          }),
          history: os.x['engine-hermes'].cron.history.handler(async ({ input, context }) => {
            requireViewer(context);
            return invokeHermes('cron/history', input) as Promise<{ runs: Record<string, unknown>[]; limit: number }>;
          }),
          delete: os.x['engine-hermes'].cron.delete.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.cron.delete', context);
            return invokeHermes('cron/delete', input);
          }),
        },
        kanban: {
          boards: os.x['engine-hermes'].kanban.boards.handler(async ({ context }) => {
            requireViewer(context);
            return invokeHermes('kanban/boards', {}) as Promise<{ boards: Record<string, unknown>[]; current: string }>;
          }),
          createBoard: os.x['engine-hermes'].kanban.createBoard.handler(async ({ input, context }) => {
            requireMember(context);
            return invokeHermes('kanban/create-board', input) as Promise<Record<string, unknown>>;
          }),
          board: os.x['engine-hermes'].kanban.board.handler(async ({ input, context }) => {
            requireViewer(context);
            return invokeHermes('kanban/board', input) as Promise<{ columns: { name: string; tasks: Record<string, unknown>[] }[]; assignees: string[]; latest_event_id: number; now: number }>;
          }),
          create: os.x['engine-hermes'].kanban.create.handler(async ({ input, context }) => {
            requireMember(context);
            return invokeHermes('kanban/create', input) as Promise<{ task: Record<string, unknown> | null }>;
          }),
          assign: os.x['engine-hermes'].kanban.assign.handler(async ({ input, context }) => {
            requireMember(context);
            return invokeHermes('kanban/assign', input) as Promise<{ task: Record<string, unknown> }>;
          }),
          task: os.x['engine-hermes'].kanban.task.handler(async ({ input, context }) => {
            requireViewer(context);
            return invokeHermes('kanban/task', input) as Promise<{ task: Record<string, unknown>; events: unknown[]; runs: unknown[] }>;
          }),
          dispatch: os.x['engine-hermes'].kanban.dispatch.handler(async ({ input, context }) => {
            requireMember(context);
            return invokeHermes('kanban/dispatch', input) as Promise<Record<string, unknown>>;
          }),
        },
      },
    },
    extensions: {
      list: os.extensions.list.handler(async ({ context }) => {
        authorize('extensions.list', context);
        return Promise.all(kernel.list().map((extension) => withHealth(extension.id)));
      }),
      enable: os.extensions.enable.handler(async ({ input, context }) => {
        authorize('extensions.enable', context);
        await kernel.enable(input.id);
        if (input.id === 'engine-hermes') await agentApi.sync();
        return withHealth(input.id);
      }),
      disable: os.extensions.disable.handler(async ({ input, context }) => {
        authorize('extensions.disable', context);
        if (input.id === 'engine-hermes') await agentApi.stop();
        await kernel.disable(input.id);
        return withHealth(input.id);
      }),
    },
    vault: {
      list: os.vault.list.handler(async ({ input, context }) => {
        await authorizeVault('list', input?.scope, context);
        return vault.list(input.scope);
      }),
      put: os.vault.put.handler(async ({ input, context }) => {
        await authorizeVault('put', input?.scope, context);
        return vault.put(input.scope, input.name, input.value);
      }),
      rotate: os.vault.rotate.handler(async ({ input, context }) => {
        await authorizeVault('rotate', input?.scope, context);
        return vault.rotate(input.scope, input.name, input.value);
      }),
      delete: os.vault.delete.handler(async ({ input, context }) => {
        await authorizeVault('delete', input?.scope, context);
        return { deleted: await vault.delete(input.scope, input.name) };
      }),
    },
    computers: {
      list: os.computers.list.handler(async ({ context }) => {
        authorize('computers.list', context);
        return computers.list();
      }),
      attach: os.computers.attach.handler(async ({ input, context }) => {
        authorize('computers.attach', context);
        try { return await computers.attach(input.providerId, input.target, { workspaceId: context.workspaceId ?? undefined }); }
        catch { throw new ORPCError('BAD_REQUEST', { message: 'Computer attachment failed; check the target, security type and vault credentials' }); }
      }),
      release: os.computers.release.handler(async ({ input, context }) => {
        authorize('computers.release', context);
        return { released: await computers.release(input.id) };
      }),
      lease: os.computers.lease.handler(async ({ input, context }) => {
        authorize('computers.lease', context);
        return computers.lease(input.id, input.holder);
      }),
      assign: os.computers.assign.handler(async ({ input, context }) => {
        authorize('computers.assign', context);
        computers.assign(input.engine, input.targetId, input.computerId);
        return input;
      }),
      kill: os.computers.kill.handler(async ({ input, context }) => {
        authorize('computers.kill', context);
        return computers.kill(input.engaged);
      }),
      state: os.computers.state.handler(async ({ context }) => {
        authorize('computers.state', context);
        return computers.state();
      }),
      capture: os.computers.capture.handler(async ({ input, context }) => {
        authorize('computers.capture', context);
        try { return await computers.capture(input.id); }
        catch { throw new ORPCError('BAD_GATEWAY', { message: 'Computer capture failed; release and reattach the computer' }); }
      }),
    },
    events: {
      subscribe: os.events.subscribe.handler(async function* ({ input, signal, context }) {
        authorize('events.subscribe', context);
        yield* kernel.events.subscribe(input.since, signal);
      }),
    },
  };

  const wsTickets = new Map<string, { context: GatewayAuthContext; expiresAt: number }>();

  const httpRPC = new HttpRPCHandler(router);
  const wsRPC = new WSRPCHandler(router);

  const http = createServer(async (req, res) => {
    try {
      const refused = refuseRequest(req.headers, gatewayPort);
      if (refused) { res.writeHead(refused).end(); return; }
      const origin = req.headers.origin;
      // The web/PWA shell runs on a separate localhost port during development.
      if (origin && ALLOWED_ORIGIN.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? 'content-type, authorization');
        if (req.headers['access-control-request-private-network'] === 'true') {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
      }
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (path === '/internal/memory/context' || path === '/internal/memory/write') {
        if (!kernel.hasRoute('/x/memory-local/list')) { res.writeHead(404).end(); return; }
        const writing = path.endsWith('/write');
        if (req.method !== (writing ? 'POST' : 'GET')) { res.writeHead(405).end(); return; }
        const profile = writing ? undefined : url.searchParams.get('profile');
        let payload: Record<string, unknown> = {};
        if (writing) {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > 65_536) { res.writeHead(413).end(); return; }
            chunks.push(chunk as Buffer);
          }
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
          catch { res.writeHead(400).end(); return; }
        }
        const engine = writing ? payload.engine ?? 'hermes' : url.searchParams.get('engine') ?? 'hermes';
        const name = writing ? payload.profile : profile;
        const validProfile = engine === 'dsh'
          ? typeof name === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)
          : engine === 'hermes' && typeof name === 'string' && /^(default|[a-z][a-z0-9_-]{0,47})$/.test(name);
        if (!validProfile || typeof name !== 'string') { res.writeHead(400).end(); return; }
        const consumer = memoryConsumers.get(memoryKey(engine as 'hermes' | 'dsh', name));
        if (!consumer) { res.writeHead(401).end(); return; }
        const provided = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];
        const expected = await vault.get(memoryScope(consumer), 'NEO_MEMORY_TOKEN');
        if (!provided || !expected || !timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) {
          res.writeHead(401).end(); return;
        }
        if (!writing) {
          const query = (url.searchParams.get('q') ?? '').slice(0, 500);
          const scoped = await invokeMemory('list', { workspace: consumer.workspace, query }) as Array<{
            text: string; source: string; trust: string; subject: 'user' | 'bot'; subject_id: string;
          }>;
          const entries = scoped.filter((entry) => entry.subject_id === 'global' || entry.subject_id === name);
          const localContext = entries.slice(0, 15)
            .map((entry) => '- ' + entry.text + ' [' + entry.source + '; ' + entry.trust + ']')
            .join('\n').slice(0, 2800);
          let honchoContext = '';
          if (kernel.hasRoute('/x/memory-honcho/context')) {
            try {
              const lines = await invokeHoncho('context', {
                workspace: consumer.workspace, subjectId: engine + '/' + name,
              }) as string[];
              honchoContext = lines.slice(-8).map((line) =>
                '- honcho: ' + line.replace(/\s+/g, ' ').slice(0, 350)).join('\n');
            } catch { /* L2 outage cannot stop the turn */ }
          }
          const context = [localContext, honchoContext].filter(Boolean).join('\n').slice(0, 6000);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ context }));
        } else {
          const assistant = payload.assistant;
          const user = payload.user;
          const session = payload.session_id;
          if (payload.type !== 'turn' || typeof assistant !== 'string' || !assistant.trim() || assistant.length > 16000
            || typeof user !== 'string' || user.length > 16000 || typeof session !== 'string' || session.length > 200
            || (engine === 'dsh' && session !== name)) {
            res.writeHead(400).end(); return;
          }
          const entry = await invokeMemory('add', { workspace: consumer.workspace, subject: 'bot', subjectId: name,
            text: assistant.trim(), source: `${engine}.turn`,
            provenance: engine === 'dsh' ? `dsh:${session}` : `profile=${name}; session=${session}`,
            trust: 'observed' }) as { id: string };
          // Retain the L1 acknowledgement path. The bounded L2 retry runs independently.
          void writeHonchoWithRetry({
            workspace: consumer.workspace, subjectId: engine + '/' + name,
            session, user, assistant: assistant.trim(),
          });
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: entry.id }));
        }
        return;
      }

      if (path === '/internal/computers/action') {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
        if (!match) { res.writeHead(401).end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 16_384) { res.writeHead(413).end(); return; }
          chunks.push(chunk as Buffer);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400).end();
          return;
        }
        const parsed = computerActionSchema.safeParse(payload);
        if (!parsed.success) { res.writeHead(400).end(); return; }
        try {
          const result = await computers.act(match[1]!, parsed.data);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(403, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: (error as Error).message }));
        }
        return;
      }

      if (path === '/auth/ws-ticket') {
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const context = await resolveAuthContext(auth, req);
        if (!context?.user) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const now = Date.now();
        for (const [key, val] of wsTickets.entries()) {
          if (val.expiresAt <= now) wsTickets.delete(key);
        }
        const ticket = randomBytes(32).toString('hex');
        wsTickets.set(ticket, { context, expiresAt: now + 15_000 });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ticket }));
        return;
      }

      if (path.startsWith('/auth/')) {
        // Desktop mode has exactly one bootstrapped owner; any loopback caller
        // (another OS user, a rebinding web page) must not self-register.
        if (mode === 'desktop' && path.startsWith('/auth/sign-up')) {
          res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Sign-up is disabled in desktop mode' }));
          return;
        }
        await authNodeHandler(req, res);
        return;
      }

      const context = await resolveAuthContext(auth, req);
      if (!context?.user) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (path.startsWith('/x/engine-t3/') || path.startsWith('/x/engine-hermes/') || path.startsWith('/x/engine-dsh/') || path.startsWith('/x/engine-superagent/') || path.startsWith('/x/memory-local/') || path.startsWith('/x/memory-honcho/') || path.startsWith('/x/skills-registry/') || path.startsWith('/x/models/') || path.startsWith('/x/channels/')) {
        // Order for every role: authorize the procedure, then report availability,
        // then let oRPC validate method and input. Authorization runs before
        // anything else, so no role learns more than its policy allows, and a
        // disabled engine answers 404 whatever the request body or method.
        const procedure = path.slice(1).split('/').join('.');
        if (CONTRACT_POLICY[procedure]) {
          authorize(procedure, context as GatewayAuthContext);
          const extensionPath = path.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
          // Honcho status/list and channels report their own disabled state.
          const selfReporting = path === '/x/memory-honcho/status' || path === '/x/memory-honcho/list' || path.startsWith('/x/channels/');
          if (!selfReporting && !kernel.hasRoute(extensionPath)) {
            res.writeHead(404).end();
            return;
          }
        }
        const matched = await httpRPC.handle(req, res, { context: context as GatewayAuthContext });
        if (!matched.matched) res.writeHead(404).end();
        return;
      }

      if (kernel.hasRoute(path)) {
        if (!context?.user) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        authorize(path, context as GatewayAuthContext);
        if (req.method !== 'GET') {
          res.writeHead(405).end();
          return;
        }
        const result = await kernel.invokeRoute(path, 'GET');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
        return;
      }

      if (path.startsWith('/x/')) {
        res.writeHead(404).end();
        return;
      }

      if (req.method === 'POST' && !context?.user) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const matched = await httpRPC.handle(req, res, { context: context as GatewayAuthContext });
      if (!matched.matched) res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) {
        const err = error as any;
        const status = err?.status ?? (err?.code === 'FORBIDDEN' ? 403 : err?.code === 'UNAUTHORIZED' ? 401 : 500);
        res.writeHead(status, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const refused = refuseRequest(req.headers, gatewayPort);
    if (refused) {
      socket.write(refused === 421 ? 'HTTP/1.1 421 Misdirected Request\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    let context: GatewayAuthContext | null = null;
    let selectedProtocol: string | undefined;

    const subprotocols = (req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const bearerProto = subprotocols.find((p) => p.startsWith('bearer.'));
    if (bearerProto) {
      const token = bearerProto.slice(7);
      context = (await resolveAuthContext(auth, {
        headers: { authorization: `Bearer ${token}` },
      })) as GatewayAuthContext;
      if (context?.user) {
        selectedProtocol = bearerProto;
      } else {
        context = null;
      }
    }

    if (!context) {
      const ticket = url.searchParams.get('ticket');
      if (ticket) {
        const entry = wsTickets.get(ticket);
        if (entry) {
          wsTickets.delete(ticket);
          if (Date.now() <= entry.expiresAt) {
            context = entry.context;
          }
        }
      }
    }

    if (!context?.user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const upgradeHeaders: string[] = [];
    if (selectedProtocol) {
      upgradeHeaders.push(`Sec-WebSocket-Protocol: ${selectedProtocol}`);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).authContext = context;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket & { authContext?: GatewayAuthContext }) => {
    void wsRPC.upgrade(ws, { context: ws.authContext! });
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 0, '127.0.0.1', resolveListen);
    });
  } catch (error) {
    await kernel.close();
    throw error;
  }

  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected gateway address');
  gatewayPort = address.port;
  if (auth.options) {
    auth.options.baseURL = `http://127.0.0.1:${gatewayPort}`;
  }

  return {
    port: address.port,
    kernel,
    vault,
    computers,
    desktopToken,
    get setupToken() { return setupToken; },
    auth,
    db,
    router,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
      http.closeAllConnections();
      await new Promise<void>((done) => http.close(() => done()));
      await agentApi.stop();
      await kernel.close();
      await db.close();
    },
  };
}
