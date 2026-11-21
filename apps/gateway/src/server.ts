import { codingWorkflowRouter } from './coding-workflow.js';
import { ComputerMcpBridge } from '@neometaharness/kernel';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, linkSync, unlinkSync, existsSync, mkdirSync, renameSync } from 'node:fs';
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
  type DreamReport,
} from '@neometaharness/contracts';
import {
  VaultService,
  KeyFileProvider,
  restrictPrivatePath,
  type KeyProvider,
  type VaultScope,
} from '@neometaharness/vault';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { NeoKernel, SettingsValidationError, SkillsBridge } from '@neometaharness/kernel';
import { ComputerRegistry } from '@neometaharness/computers';
import {
  createNeoAuth,
  migrateAuthSchema,
  bootstrapDesktopAuth,
  deploymentOwnerLookup,
  resolveAuthContext,
  transferDeploymentOwner,
  type NeoAuth,
} from '@neometaharness/auth';
import { toNodeHandler } from 'better-auth/node';
import { coalesceText } from './coalesce.js';
import { ChannelBus } from './channel-bus.js';
import { createAgentGateway } from './agents.js';
import { backupSource } from './backup-source.js';
import {
  requireViewer,
  requireMember,
  requireAdminOrOwner,
  requireOwner,
  type GatewayAuthContext,
} from './rbac.js';
import {
  authorize,
  canSeeDeploymentItems,
  authorizeInboxAction,
  authorizeDeploymentSettingsWrite,
  hasDeploymentSettings,
  requireDeploymentOwner,
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
  /** Driver factory injection for isolated host implementations and fake-driver tests. */
  computerLocalDriverFactory?: import('../../../extensions/computer-local/src/provider.js').LocalDriverFactory;
  /** Injection for the fake Hermes screen in isolated gateway tests. */
  hermesScreenBridge?: import('../../../extensions/computer-hermes-screen/src/provider.js').HermesScreenBridge;
  orgoClient?: import('../../../extensions/computer-orgo/src/provider.js').OrgoClient;
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

/** Vault name of engine memory callback tokens; only the Gateway writes these. */
const MEMORY_TOKEN = 'NEO_MEMORY_TOKEN';

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
    mode,
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
  let desktopOwnerId: string | undefined;
  // Desktop is one workspace: its settings apply everywhere, and pre-P1-13 settings move into it.
  let desktopWorkspace: string | undefined;
  if (mode === 'desktop') {
    const desktop = await bootstrapDesktopAuth(auth, { dataDir });
    desktopToken = desktop.token;
    desktopOwnerId = desktop.user.id;
    desktopWorkspace = desktop.workspace.id;
  }
  const isServerDeploymentOwner = deploymentOwnerLookup(db.sqlite);
  const resolveGatewayAuth = async (headers: Parameters<typeof resolveAuthContext>[1]): Promise<GatewayAuthContext> => {
    const context = await resolveAuthContext(auth, headers);
    const userId = context.session && context.user?.id;
    return {
      ...context,
      deploymentMode: mode,
      isDeploymentOwner: () => Boolean(userId && (mode === 'desktop' ? userId === desktopOwnerId : isServerDeploymentOwner(userId))),
    };
  };

  const onboardingFile = join(dataDir, 'onboarding.json');
  const readOnboardingCompletion = (): string | null => {
    try {
      const state: unknown = JSON.parse(readFileSync(onboardingFile, 'utf8'));
      if (state && typeof state === 'object' && 'completedAt' in state &&
          typeof state.completedAt === 'string' && Number.isFinite(Date.parse(state.completedAt))) {
        return state.completedAt;
      }
      throw new Error('Invalid onboarding state');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const onboardingStatus = async (context: GatewayAuthContext) => {
    const completedAt = readOnboardingCompletion();
    const workspace = context.workspaceId ? await kyselyDb.selectFrom('organization')
      .select('name').where('id', '=', context.workspaceId).executeTakeFirst() : undefined;
    return { completed: completedAt !== null, completedAt,
      ownerName: context.user?.name ?? context.user?.email ?? 'Workspace owner',
      workspaceName: workspace?.name ?? 'Default Workspace', mode };
  };

  const authNodeHandler = toNodeHandler(auth);

  const vault = new VaultService(db, options.vaultKeyProvider ?? new KeyFileProvider(
    options.vaultKeyFile ?? join(dirname(resolve(options.databaseFile)), 'vault-keys', 'master.key'),
  ));

  let gatewayPort = 0;
  const computerMcpBridge = new ComputerMcpBridge();
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
    let token = await vault.get(scope, MEMORY_TOKEN);
    if (!token) {
      token = randomBytes(32).toString('hex');
      await vault.put(scope, MEMORY_TOKEN, token);
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
  const extensionDataDir = join(dirname(resolve(options.databaseFile)), 'extensions');
  const backupStorage = backupSource(db, extensionDataDir,
    options.vaultKeyFile ?? join(dirname(resolve(options.databaseFile)), 'vault-keys', 'master.key'));
  // Channel platforms publish into, and the Inbox subscribes to, this one bus.
  const channelBus = new ChannelBus();
  /** The first workspace created (whose owner set the deployment up); undefined before any exists. */
  const bootstrapWorkspace = async () => (await auth.kysely?.selectFrom('organization').select('id')
    .orderBy('createdAt').executeTakeFirst() as { id: string } | undefined)?.id;
  const kernel = new NeoKernel(db, {
    // Read-only deployment mode, for extensions whose background work differs per mode (memory-honcho's nightly pass).
    deploymentMode: mode,
    backupSource: backupStorage,
    backupProtectedPaths: [dataDir, dirname(resolve(options.databaseFile)), resolve(options.extensionsDir ?? defaultExtensions)],
    channelSource: channelBus,
    channelBus,
    computers,
    computerProfileWorkspace: async (profile: string): Promise<string | undefined> => {
      if (mode === 'desktop') return undefined;
      const botId = /^neo_[a-f0-9]{32}$/i.test(profile)
        ? profile.slice(4).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
        : profile;
      return (await db.agents.getBot(botId))?.workspace_id ?? undefined;
    },
    computerMcpBridge,
    computerLocalDriverFactory: options.computerLocalDriverFactory,
    hermesScreen: options.hermesScreenBridge,
    orgoClient: options.orgoClient,
    vault,
    auth,
    memoryRecords: (db as any).memories,
    memoryBridge,
    dshMemoryBridge,
    skillsBridge,
    extensionDataDir,
    gatewayUrl: () => `http://127.0.0.1:${gatewayPort}`,
    // P1-13: where an extension keeps a workspace's own configuration (Model Hub, Panda). Desktop has one
    // ('default', unchanged); server mode keeps each workspace apart, and 'default' is the deployment's.
    workspaceDirectory: {
      key: (workspace?: string) => mode === 'desktop' ? 'default' : workspace ?? 'default',
      bootstrap: async () => mode === 'desktop' ? undefined : bootstrapWorkspace(),
    },
  }, dataDir, process.env.NMH_EXTENSION_PYTHON, {
    fallbackWorkspace: mode === 'desktop' ? desktopWorkspace : null,
    deploymentSettings: mode === 'server' ? hasDeploymentSettings : undefined,
    // Server mode: pre-P1-13 settings belong to the bootstrap workspace (the first one created, whose owner set
    // the deployment up). With no workspace yet the legacy rows wait; the first access after it appears moves them.
    legacyWorkspace: bootstrapWorkspace,
  });

  const authorizeVault = async (operation: VaultOperation, scope: VaultScope, context?: GatewayAuthContext, name?: string) => {
    const procedure = `vault.${operation}`;
    authorize(procedure, context);
    // Engine memory callback tokens (Hermes profiles, DSH sessions) are issued and checked by the Gateway alone
    // (issueMemoryBinding, /internal/memory). No user role, the deployment owner included, may set, rotate or remove one.
    if (operation !== 'list' && name === MEMORY_TOKEN) {
      throw new ORPCError('FORBIDDEN', { message: 'Engine memory tokens are managed by the Gateway' });
    }
    // Settings secrets use a bare extension ID. Profile credentials in the
    // deployment vault are covered by the instance-scope check below.
    const deploymentSettingsWrite = operation !== 'list' && scope?.kind === 'engine'
      && authorizeDeploymentSettingsWrite(scope.subjectId, context);
    // An extension's secret settings live at its engine scope (P1-13). Writing them is changing that extension's
    // settings, so it needs settings.set (admin) in the scope's workspace, whatever vault.put allows elsewhere.
    const settingsSecret = operation !== 'list' && scope?.kind === 'engine' && !!scope.subjectId
      && kernel.hasExtension(scope.subjectId);
    if (!deploymentSettingsWrite && scope?.workspaceId) {
      const kysely = auth.kysely;
      const target = await kysely.selectFrom('organization').select('id')
        .where('id', '=', scope.workspaceId).executeTakeFirst();
      if (!target && mode === 'server') {
        requireDeploymentOwner(context);
      } else {
        authorize(procedure, context, { workspaceOnly: true });
        if (settingsSecret) authorize('settings.set', context, { workspaceOnly: true });
      }
      if (scope.workspaceId !== context?.workspaceId && (target || mode === 'desktop')) {
        const userId = context?.user?.id;
        const memberRole = async (organizationId: string) => (await kysely.selectFrom('member').select('role')
          .where('userId', '=', userId).where('organizationId', '=', organizationId)
          .executeTakeFirst() as { role: string } | undefined)?.role;
        let held: string | undefined;
        if (target) {
          held = await memberRole(scope.workspaceId);
        } else {
          const bootstrap = await kysely.selectFrom('organization').select('id')
            .orderBy('createdAt').executeTakeFirst() as { id: string } | undefined;
          held = bootstrap && (await memberRole(bootstrap.id)) === 'owner' ? 'owner' : undefined;
        }
        if (!held) throw new ORPCError('FORBIDDEN', { message: 'Cross-workspace vault access forbidden' });
        authorize(procedure, { ...context!, workspaceId: scope.workspaceId, role: held as GatewayAuthContext['role'] }, { workspaceOnly: true });
        if (settingsSecret) authorize('settings.set', { ...context!, workspaceId: scope.workspaceId, role: held as GatewayAuthContext['role'] }, { workspaceOnly: true });
      }
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

  const agentApi = await createAgentGateway(db, kernel, mode);
  const computerWorkspace = (workspaceId: string | null): string | undefined => {
    if (mode === 'desktop') return undefined;
    if (!workspaceId) throw new ORPCError('FORBIDDEN', { message: 'Workspace required' });
    return workspaceId;
  };
  for (const extension of kernel.list()) {
    if (extension.version) backupStorage.versions[extension.id] = extension.version;
  }
  // P1-13: every procedure runs inside the caller's workspace, so extension settings resolve per workspace
  // (desktop: always its one workspace; server: the caller's, or none, which yields schema defaults only).
  const settingsWorkspace = (context: GatewayAuthContext | null | undefined): string | undefined =>
    mode === 'desktop' ? desktopWorkspace : context?.workspaceId ?? undefined;
  const os = implement(neoContract).$context<GatewayAuthContext>().use(policyMiddleware as any)
    .use((async ({ context, next }: { context: GatewayAuthContext; next: () => Promise<unknown> }) =>
      kernel.runInWorkspace(settingsWorkspace(context), () => next())) as any);

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
    try { return await kernel.invokeRoute(path, 'RPC', body); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith('Unknown DSH session')) throw new ORPCError('NOT_FOUND', { message: 'Unknown DSH session' });
      throw error;
    }
  };
  /** Server mode: a DSH session is reachable only from the workspace that created it (P1-13). */
  const dshScoped = <T extends object>(input: T, context: GatewayAuthContext): T =>
    mode === 'desktop' ? input : { ...input, workspaceId: inboxWorkspace(context) };
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
  // Memory is per workspace. In server mode a caller may only name their own workspace ('default' means
  // "mine"); any other name is refused. Desktop is a single tenant whose sessions name memory workspaces
  // freely (DSH sessions, the legacy 'default'), so every name there belongs to the one owner.
  const memoryWorkspace = (requested: string | undefined, context: GatewayAuthContext): string => {
    if (mode === 'desktop') return requested ?? 'default';
    const own = context.workspaceId;
    if (!own) throw new ORPCError('FORBIDDEN', { message: 'Workspace membership required' });
    if (requested === undefined || requested === 'default' || requested === own) return own;
    throw new ORPCError('FORBIDDEN', { message: 'Memory belongs to another workspace' });
  };
  /** The workspace an id-addressed memory write must belong to (none to check in desktop mode). */
  const memoryOwner = (context: GatewayAuthContext) => mode === 'desktop' ? undefined : memoryWorkspace(undefined, context);
  /**
   * Memory provenance is assigned here from the authenticated caller, never taken from the request. The
   * superagent's worker MCP bridge key (memory.remember) keeps that tool's own wording; the user id is always
   * appended, so a key that merely borrows the bridge's name still names its real owner.
   */
  /**
   * The accept-mode workspace of a caller: desktop keeps its single 'default' mode; in server mode each
   * workspace has its own (the same key its memory dreams use, so a dream follows the caller's setting).
   */
  const acceptModeWorkspace = (context: GatewayAuthContext): string => mode === 'desktop' ? 'default' : memoryWorkspace(undefined, context);
  /**
   * P6-10 Inbox isolation. Stamped items belong to the caller's workspace.
   * Unstamped channel/Hermes bindings, GitHub and upstream items belong to the deployment.
   */
  const inboxWorkspace = (context: GatewayAuthContext): string | undefined => {
    if (mode === 'desktop') return undefined;
    if (!context.workspaceId) throw new ORPCError('FORBIDDEN', { message: 'Workspace membership required' });
    return context.workspaceId;
  };
  const isDeploymentInboxItem = (item: Pick<InboxItem, 'workspace' | 'source'>) =>
    !item.workspace && (item.source === 'neo/binding' || item.source === 'neo/upstream' || item.source === 'neo/github');
  const inboxVisible = (item: Pick<InboxItem, 'workspace' | 'source'>, context: GatewayAuthContext, role = context.role) => {
    if (mode === 'desktop') return true;
    if (item.workspace) return Boolean(role && item.workspace === context.workspaceId);
    return isDeploymentInboxItem(item) && canSeeDeploymentItems(context);
  };
  const isDeploymentSchedule = (job: { workspace?: string; botId: string; text: string }) =>
    !job.workspace && job.botId === 'neo-system' && job.text === '@neo/upstream check';
  const scheduleVisible = (job: { workspace?: string; botId: string; text: string }, context: GatewayAuthContext) =>
    inboxVisible(job, context) || (isDeploymentSchedule(job) && canSeeDeploymentItems(context));
  const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;
  /**
   * The caller's role now (null: no longer a member), never above the role the stream opened with. Long-lived
   * streams re-check it so a removed or demoted member stops receiving events. Desktop has one owner.
   */
  const currentInboxRole = async (context: GatewayAuthContext): Promise<GatewayAuthContext['role'] | null> => {
    if (mode === 'desktop') return context.role;
    if (!context.user?.id || !context.workspaceId || !context.role) return null;
    const row = await kyselyDb.selectFrom('member').select('role').where('userId', '=', context.user.id)
      .where('organizationId', '=', context.workspaceId).executeTakeFirst() as { role?: keyof typeof ROLE_RANK } | undefined;
    const held = row?.role;
    if (!held || !(held in ROLE_RANK)) return null;
    return ROLE_RANK[held] < ROLE_RANK[context.role as keyof typeof ROLE_RANK] ? held : context.role;
  };
  /** The caller's item, or NOT_FOUND (another workspace's item is indistinguishable from a missing one). */
  const inboxItemForAction = async (procedure: string, id: string, context: GatewayAuthContext) => {
    const item = (await invokeInbox('list', {}) as InboxItem[]).find((entry) => entry.id === id);
    if (!item || !inboxVisible(item, context)) throw new ORPCError('NOT_FOUND', { message: 'Inbox item not found' });
    const role = authorizeInboxAction(procedure, context, isDeploymentInboxItem(item) ? 'deployment' : 'workspace');
    return { item, role };
  };
  /** The caller's schedule, or NOT_FOUND (another workspace's schedule is indistinguishable from a missing one). */
  const authorizeCronJob = async (procedure: string, id: string, context: GatewayAuthContext) => {
    // Desktop keeps its old answers for unknown ids ({ deleted: false } and the like).
    if (mode === 'desktop') return;
    const job = (await invokeInbox('cron/list', {}) as { id: string; workspace?: string; botId: string; text: string }[]).find((entry) => entry.id === id);
    if (!job || !scheduleVisible(job, context)) throw new ORPCError('NOT_FOUND', { message: 'Schedule not found' });
    authorizeInboxAction(procedure, context, isDeploymentSchedule(job) ? 'deployment' : 'workspace');
  };
  const memoryProvenance = (context: GatewayAuthContext): string => {
    const user = `user:${context.user?.id ?? 'unknown'}`;
    const key = context.apiKey?.name;
    if (key === 'superagent-bridge') return `explicit user request through Neo worker MCP; ${user}`;
    if (key) return `API key ${key}; ${user}`;
    return `Neo Memory UI; ${user}`;
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
  const invokeMetrics = async (body: { workspace?: string; onboardingCompletedAt?: string | null }) => {
    const path = '/x/metrics/summary';
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Metrics extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  const invokeModels = async (route: string, body: unknown) => {
    const path = `/x/models/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Model Hub extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  /** The deployment's own Model Hub / Panda store (workspaceDirectory key); only deployment-owner routes use it. */
  const DEPLOYMENT_CONFIG = 'default';
  /** Model Hub and Panda configuration is the caller's workspace's (P1-13); desktop has its one. */
  const modelsWorkspace = (context: GatewayAuthContext): string | undefined => {
    if (mode === 'desktop') return undefined;
    if (!context.workspaceId) throw new ORPCError('FORBIDDEN', { message: 'Workspace membership required' });
    return context.workspaceId;
  };
  const invokePanda = async (route: string, body: unknown) => {
    const path = `/x/models-router-panda/${route}`;
    if (!kernel.hasRoute(path)) throw new ORPCError('NOT_FOUND', { message: 'Panda router extension is disabled' });
    return kernel.invokeRoute(path, 'RPC', body);
  };
  type SkillRecord = RegistrySkill;
  const withHealth = async (extension: ReturnType<typeof kernel.status>) => {
    const health = await kernel.health(extension.id).catch(() => ({ ok: false }));
    return { ...extension, ...(health ? { health } : {}) };
  };
  const syncBackupVersion = (id: string) => {
    const version = kernel.list().find(extension => extension.id === id)?.version;
    if (version) backupStorage.versions[id] = version;
    else delete backupStorage.versions[id];
  };

  const router = {
    system: {
      transferDeploymentOwner: os.system.transferDeploymentOwner.handler(async ({ input, context }) => {
        authorize('system.transferDeploymentOwner', context);
        if (mode !== 'server') throw new ORPCError('NOT_FOUND');
        const ownerId = context.user!.id;
        if (input.userId === ownerId) throw new ORPCError('BAD_REQUEST', { message: 'Choose a different user' });
        if (!(await transferDeploymentOwner(kyselyDb, ownerId, input.userId))) {
          authorize('system.transferDeploymentOwner', context);
          throw new ORPCError('NOT_FOUND', { message: 'User not found' });
        }
        return { userId: input.userId };
      }),
      restore: os.system.restore.handler(async ({ input, context }) => {
        authorize('system.restore', context);
        if (!kernel.hasRoute('/x/backup/restore')) throw new ORPCError('NOT_FOUND', { message: 'Backup extension is disabled' });
        try {
          return await kernel.invokeRoute('/x/backup/restore', 'RPC', input) as { dataDir: string; databaseFile: string; files: number; format: number };
        } catch (error) { throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : 'Restore failed' }); }
      }),
      backup: os.system.backup.handler(async ({ input, context }) => {
        authorize('system.backup', context);
        if (!kernel.hasRoute('/x/backup/backup')) throw new ORPCError('NOT_FOUND', { message: 'Backup extension is disabled' });
        try {
          return await kernel.invokeRoute('/x/backup/backup', 'RPC', input) as { out: string; files: number; format: number };
        } catch (error) { throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : 'Backup failed' }); }
      }),
    },
    onboarding: {
      get: os.onboarding.get.handler(async ({ context }) => {
        authorize('onboarding.get', context);
        return onboardingStatus(context);
      }),
      complete: os.onboarding.complete.handler(async ({ context }) => {
        authorize('onboarding.complete', context);
        if (!readOnboardingCompletion()) {
          mkdirSync(dataDir, { recursive: true });
          const temporary = `${onboardingFile}.${randomUUID()}.tmp`;
          try {
            writeFileSync(temporary, JSON.stringify({ completedAt: new Date().toISOString() }), { mode: 0o600 });
            renameSync(temporary, onboardingFile);
          } finally {
            if (existsSync(temporary)) unlinkSync(temporary);
          }
        }
        return onboardingStatus(context);
      }),
    },
    agents: agentApi.router,
    inbox: {
      ask: os.inbox.ask.handler(async ({ input, context }) => {
        authorize('inbox.ask', context);
        const notification = input.notify ? (authorize('x.channels.notification.resolve', context),
          await invokeChannels('notification/resolve', { ...input.notify, botId: input.botId })) : undefined;
        const workspace = inboxWorkspace(context);
        return invokeInbox('ask', { ...input, ...(notification ? { notification } : {}), requesterRole: context.role,
          requesterId: context.user?.id, ...(workspace ? { workspace } : {}) }) as Promise<InboxItem>;
      }),
      list: os.inbox.list.handler(async ({ context }) => {
        authorize('inbox.list', context);
        const items = await invokeInbox('list', {}) as InboxItem[];
        return items.filter((item) => inboxVisible(item, context));
      }),
      decisions: {
        list: os.inbox.decisions.list.handler(async ({ input, context }) => {
          authorize('inbox.decisions.list', context);
          type Decision = import('@neometaharness/contracts').InboxDecision;
          if (mode === 'desktop') return invokeInbox('decisions/list', input) as Promise<Decision[]>;
          // Decision records carry their item's workspace; the store returns only the caller's (bounded by limit).
          return invokeInbox('decisions/list', { ...input, workspace: inboxWorkspace(context) }) as Promise<Decision[]>;
        }),
      },
      accept: os.inbox.accept.handler(async ({ input, context }) => {
        authorizeInboxAction('inbox.accept', context);
        const { item, role } = await inboxItemForAction('inbox.accept', input.id, context);
        // Accepting a Suggestion starts work: destructive work needs an admin or owner (as approvals do).
        if (item.destructive && role !== 'admin' && role !== 'owner') {
          throw new ORPCError('FORBIDDEN', { message: 'Accepting destructive work requires admin or owner' });
        }
        return invokeInbox('accept', { ...input, role }) as Promise<InboxItem>;
      }),
      dismiss: os.inbox.dismiss.handler(async ({ input, context }) => {
        authorizeInboxAction('inbox.dismiss', context);
        const { role } = await inboxItemForAction('inbox.dismiss', input.id, context);
        return invokeInbox('dismiss', { ...input, role }) as Promise<InboxItem>;
      }),
      acceptMode: {
        get: os.inbox.acceptMode.get.handler(async ({ context }) => {
          authorize('inbox.acceptMode.get', context);
          return invokeInbox('accept-mode/get', { workspace: acceptModeWorkspace(context) }) as Promise<{ mode: import('@neometaharness/contracts').AcceptMode }>;
        }),
        set: os.inbox.acceptMode.set.handler(async ({ input, context }) => {
          authorize('inbox.acceptMode.set', context);
          return invokeInbox('accept-mode/set', { ...input, workspace: acceptModeWorkspace(context) }) as Promise<{ mode: import('@neometaharness/contracts').AcceptMode }>;
        }),
      },
      reply: os.inbox.reply.handler(async ({ input, context }) => {
        authorizeInboxAction('inbox.reply', context);
        await inboxItemForAction('inbox.reply', input.id, context);
        return invokeInbox('reply', input) as Promise<InboxItem>;
      }),
      approval: { decide: os.inbox.approval.decide.handler(async ({ input, context }) => {
        authorizeInboxAction('inbox.approval.decide', context);
        const { item, role } = await inboxItemForAction('inbox.approval.decide', input.id, context);
        if ((item.approval?.destructive || item.source === 'neo/github') && role !== 'admin' && role !== 'owner') {
          throw new ORPCError('FORBIDDEN', { message: 'Destructive approval requires admin or owner' });
        }
        return invokeInbox('approval/decide', { ...input, role }) as Promise<InboxItem>;
      }) },
      retry: os.inbox.retry.handler(async ({ input, context }) => {
        authorizeInboxAction('inbox.retry', context);
        await inboxItemForAction('inbox.retry', input.id, context);
        return invokeInbox('retry', input) as Promise<InboxItem>;
      }),
      upstream: {
        check: os.inbox.upstream.check.handler(async ({ context }) => {
          authorize('inbox.upstream.check', context);
          return invokeInbox('upstream/check', {}) as Promise<{ checked: number; drift: number }>;
        }),
        configure: os.inbox.upstream.configure.handler(async ({ input, context }) => {
          authorize('inbox.upstream.configure', context);
          return invokeInbox('upstream/configure', input) as Promise<{ ok: boolean }>;
        }),
        status: os.inbox.upstream.status.handler(async ({ context }) => {
          authorize('inbox.upstream.status', context);
          return invokeInbox('upstream/status', {}) as Promise<{ botId: string | null; lastCheckedAt: number | null;
            lastDrift: number | null; lastError: string | null }>;
        }),
      },
      github: {
        pullRequest: os.inbox.github.pullRequest.handler(async ({ input, context }) => {
          authorize('inbox.github.pullRequest', context);
          return invokeInbox('github/pull-request', input) as Promise<{ number: number; url: string; branch: string; commit: string } | null>;
        }),
        configure: os.inbox.github.configure.handler(async ({ input, context }) => {
          authorize('inbox.github.configure', context);
          return invokeInbox('github/configure', input) as Promise<{ ok: boolean }>;
        }),
        status: os.inbox.github.status.handler(async ({ context }) => {
          authorize('inbox.github.status', context);
          return invokeInbox('github/status', {}) as Promise<{
            repositories: { name: string; ref: string }[];
            mode: import('@neometaharness/contracts').AcceptMode; botId?: string; hasToken: boolean;
            pausedUntil: number | null; stopped: boolean;
          }>;
        }),
        poll: os.inbox.github.poll.handler(async ({ context }) => {
          authorize('inbox.github.poll', context);
          return invokeInbox('github/poll', {}) as Promise<{ checked: number; created: number; pausedUntil: number | null }>;
        }),
      },
      events: os.inbox.events.handler(async function* ({ input, signal, context }) {
        authorize('inbox.events', context);
        const stream = await invokeInbox('events', { ...input, signal }) as AsyncIterable<InboxEvent>;
        if (mode === 'desktop') { yield* stream; return; }
        // Membership is re-checked (at most every 5 s): a removed member's stream ends, a demoted one narrows.
        let role: GatewayAuthContext['role'] | null = await currentInboxRole(context);
        let checkedAt = Date.now();
        for await (const event of stream) {
          if (Date.now() - checkedAt >= 5_000) { role = await currentInboxRole(context); checkedAt = Date.now(); }
          if (!role && !canSeeDeploymentItems(context)) return;
          if (inboxVisible(event.item, context, role)) yield event;
        }
      }),
      cron: {
        create: os.inbox.cron.create.handler(async ({ input, context }) => {
          authorize('inbox.cron.create', context);
          const workspace = inboxWorkspace(context);
          return invokeInbox('cron/create', { ...input, requesterRole: context.role, ...(workspace ? { workspace } : {}) }) as Promise<{ id: string; text: string; botId: string; schedule: string; mode: 'observe' | 'act' }>;
        }),
        list: os.inbox.cron.list.handler(async ({ context }) => {
          authorize('inbox.cron.list', context);
          const jobs = await invokeInbox('cron/list', {}) as { id: string; text: string; botId: string; schedule: string;
            mode: 'observe' | 'act'; workspace?: string }[];
          return jobs.filter((job) => scheduleVisible(job, context));
        }),
        delete: os.inbox.cron.delete.handler(async ({ input, context }) => {
          authorizeInboxAction('inbox.cron.delete', context);
          await authorizeCronJob('inbox.cron.delete', input.id, context);
          return invokeInbox('cron/delete', input) as Promise<{ deleted: boolean }>;
        }),
        fire: os.inbox.cron.fire.handler(async ({ input, context }) => {
          authorizeInboxAction('inbox.cron.fire', context);
          if (process.env.NODE_ENV !== 'test') throw new ORPCError('NOT_FOUND');
          await authorizeCronJob('inbox.cron.fire', input.id, context);
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
      metrics: {
        summary: os.x.metrics.summary.handler(async ({ context }) => {
          authorize('x.metrics.summary', context);
          return invokeMetrics({
            workspace: inboxWorkspace(context),
            onboardingCompletedAt: mode === 'desktop' ? readOnboardingCompletion() : null,
          }) as Promise<import('@neometaharness/contracts').MetricsSummary>;
        }),
      },
      'models-router-panda': {
        deployment: {
          settings: {
            get: os.x['models-router-panda'].deployment.settings.get.handler(async ({ context }) => {
              authorize('x.models-router-panda.deployment.settings.get', context);
              return invokePanda('settings/get', { workspace: DEPLOYMENT_CONFIG }) as Promise<import('@neometaharness/contracts').PandaSettings | null>;
            }),
            set: os.x['models-router-panda'].deployment.settings.set.handler(async ({ input, context }) => {
              authorize('x.models-router-panda.deployment.settings.set', context);
              return invokePanda('settings/set', { ...input, workspace: DEPLOYMENT_CONFIG }) as Promise<import('@neometaharness/contracts').PandaSettings>;
            }),
          },
        },
        settings: {
          get: os.x['models-router-panda'].settings.get.handler(async ({ context }) => {
            requireAdminOrOwner(context);
            return invokePanda('settings/get', { workspace: modelsWorkspace(context) }) as Promise<import('@neometaharness/contracts').PandaSettings | null>;
          }),
          set: os.x['models-router-panda'].settings.set.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokePanda('settings/set', { ...input, workspace: modelsWorkspace(context) }) as Promise<import('@neometaharness/contracts').PandaSettings>;
          }),
        },
        health: os.x['models-router-panda'].health.handler(async ({ context }) => {
          requireViewer(context);
          return invokePanda('health', { workspace: modelsWorkspace(context) }) as Promise<{ ok: boolean; configured: boolean }>;
        }),
      },
      models: {
        // The deployment's configuration, used by deployment-level work (Hermes profiles, registry evaluation).
        deployment: {
          providers: {
            list: os.x.models.deployment.providers.list.handler(async ({ context }) => {
              authorize('x.models.deployment.providers.list', context);
              return invokeModels('providers/list', { workspace: DEPLOYMENT_CONFIG }) as Promise<ModelProviderRecord[]>;
            }),
            put: os.x.models.deployment.providers.put.handler(async ({ input, context }) => {
              authorize('x.models.deployment.providers.put', context);
              return invokeModels('providers/put', { ...input, workspace: DEPLOYMENT_CONFIG }) as Promise<ModelProviderRecord>;
            }),
            delete: os.x.models.deployment.providers.delete.handler(async ({ input, context }) => {
              authorize('x.models.deployment.providers.delete', context);
              return invokeModels('providers/delete', { ...input, workspace: DEPLOYMENT_CONFIG }) as Promise<{ deleted: boolean }>;
            }),
            test: os.x.models.deployment.providers.test.handler(async ({ input, context }) => {
              authorize('x.models.deployment.providers.test', context);
              return invokeModels('providers/test', { ...input, workspace: DEPLOYMENT_CONFIG }) as Promise<{ ok: boolean; models: number; status: number }>;
            }),
          },
          roles: {
            get: os.x.models.deployment.roles.get.handler(async ({ context }) => {
              authorize('x.models.deployment.roles.get', context);
              return invokeModels('roles/get', { workspace: DEPLOYMENT_CONFIG }) as Promise<ModelRolesRecord>;
            }),
            set: os.x.models.deployment.roles.set.handler(async ({ input, context }) => {
              authorize('x.models.deployment.roles.set', context);
              return invokeModels('roles/set', { ...input, workspace: DEPLOYMENT_CONFIG }) as Promise<{ role: ModelRoleName; selection: ModelSelectionRecord }>;
            }),
          },
          override: {
            get: os.x.models.deployment.override.get.handler(async ({ input, context }) => {
              authorize('x.models.deployment.override.get', context);
              return invokeModels('override/get', { ...input, workspace: DEPLOYMENT_CONFIG }) as Promise<{ profile: string; selection: ModelSelectionRecord | null }>;
            }),
            set: os.x.models.deployment.override.set.handler(async ({ input, context }) => {
              authorize('x.models.deployment.override.set', context);
              return invokeModels('override/set', { ...input, workspace: DEPLOYMENT_CONFIG }) as Promise<{ profile: string; selection: ModelSelectionRecord | null }>;
            }),
          },
        },
        providers: {
          list: os.x.models.providers.list.handler(async ({ context }) => {
            requireViewer(context);
            return invokeModels('providers/list', { workspace: modelsWorkspace(context) }) as Promise<ModelProviderRecord[]>;
          }),
          put: os.x.models.providers.put.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('providers/put', { ...input, workspace: modelsWorkspace(context) }) as Promise<ModelProviderRecord>;
          }),
          delete: os.x.models.providers.delete.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('providers/delete', { ...input, workspace: modelsWorkspace(context) }) as Promise<{ deleted: boolean }>;
          }),
          test: os.x.models.providers.test.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('providers/test', { ...input, workspace: modelsWorkspace(context) }) as Promise<{ ok: boolean; models: number; status: number }>;
          }),
        },
        roles: {
          get: os.x.models.roles.get.handler(async ({ context }) => {
            requireViewer(context);
            return invokeModels('roles/get', { workspace: modelsWorkspace(context) }) as Promise<ModelRolesRecord>;
          }),
          set: os.x.models.roles.set.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('roles/set', { ...input, workspace: modelsWorkspace(context) }) as Promise<{ role: ModelRoleName; selection: ModelSelectionRecord }>;
          }),
        },
        override: {
          get: os.x.models.override.get.handler(async ({ input, context }) => {
            requireViewer(context);
            return invokeModels('override/get', { ...input, workspace: modelsWorkspace(context) }) as Promise<{ profile: string; selection: ModelSelectionRecord | null }>;
          }),
          set: os.x.models.override.set.handler(async ({ input, context }) => {
            requireAdminOrOwner(context);
            return invokeModels('override/set', { ...input, workspace: modelsWorkspace(context) }) as Promise<{ profile: string; selection: ModelSelectionRecord | null }>;
          }),
        },
      },
      channels: {
        notification: { resolve: os.x.channels.notification.resolve.handler(async ({ input, context }) => {
          authorize('x.channels.notification.resolve', context);
          return invokeChannels('notification/resolve', input) as Promise<{ channelId: string }>;
        }) },
        list: os.x.channels.list.handler(async ({ input, context }) => {
          authorize('x.channels.list', context);
          return invokeChannels('list', input) as Promise<any>;
        }),
        connect: os.x.channels.connect.handler(async ({ input, context }) => {
          authorize('x.channels.connect', context);
          return invokeChannels('connect', input) as Promise<{ connected: boolean }>;
        }),
        disconnect: os.x.channels.disconnect.handler(async ({ input, context }) => {
          authorize('x.channels.disconnect', context);
          return invokeChannels('disconnect', input) as Promise<{ disconnected: boolean }>;
        }),
        status: os.x.channels.status.handler(async ({ input, context }) => {
          authorize('x.channels.status', context);
          return invokeChannels('status', input) as Promise<any>;
        }),
        senders: os.x.channels.senders.handler(async ({ input, context }) => {
          authorize('x.channels.senders', context);
          return invokeChannels('senders', input) as Promise<any>;
        }),
        allow: os.x.channels.allow.handler(async ({ input, context }) => {
          authorize('x.channels.allow', context);
          return invokeChannels('allow', input) as Promise<any>;
        }),
        revoke: os.x.channels.revoke.handler(async ({ input, context }) => {
          authorize('x.channels.revoke', context);
          return invokeChannels('revoke', input) as Promise<any>;
        }),
        approve: os.x.channels.approve.handler(async ({ input, context }) => {
          authorize('x.channels.approve', context);
          return invokeChannels('approve', input) as Promise<any>;
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
          return invokeSkills('assignments', {}) as Promise<{ name: string; engine: 'hermes' | 'dsh' | 'superagent'; targetId: string }[]>;
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
          return invokeHoncho('status', { ...input, workspace: memoryWorkspace(input.workspace, context) }) as Promise<'ok' | 'degraded' | 'off'>;
        }),
        list: os.x['memory-honcho'].list.handler(async ({ input, context }) => {
          authorize('x.memory-honcho.list', context);
          if (!kernel.hasRoute('/x/memory-honcho/list')) return [];
          return invokeHoncho('list', { ...input, workspace: memoryWorkspace(input.workspace, context) }) as ReturnType<typeof db.memories.list>;
        }),
        dream: {
          run: os.x['memory-honcho'].dream.run.handler(async ({ input, context }) => {
            authorize('x.memory-honcho.dream.run', context);
            return invokeHoncho('dream/run', { workspace: memoryWorkspace(input.workspace, context) }) as Promise<DreamReport>;
          }),
          last: os.x['memory-honcho'].dream.last.handler(async ({ input, context }) => {
            authorize('x.memory-honcho.dream.last', context);
            return invokeHoncho('dream/last', { workspace: memoryWorkspace(input.workspace, context) }) as Promise<DreamReport | null>;
          }),
        },
      },
      'memory-local': {
        list: os.x['memory-local'].list.handler(async ({ input, context }) => {
          authorize('x.memory-local.list', context);
          return invokeMemory('list', { ...input, workspace: memoryWorkspace(input.workspace, context) }) as ReturnType<typeof db.memories.list>;
        }),
        add: os.x['memory-local'].add.handler(async ({ input, context }) => {
          authorize('x.memory-local.add', context);
          // The intent source is reserved, and provenance is the authenticated user, never caller-supplied.
          if (input.source === 'neo.intent') throw new ORPCError('BAD_REQUEST', { message: 'Standing intents are added through memory-local.intents.add' });
          return invokeMemory('add', { ...input, workspace: memoryWorkspace(input.workspace, context),
            provenance: memoryProvenance(context) }) as ReturnType<typeof db.memories.add>;
        }),
        update: os.x['memory-local'].update.handler(async ({ input, context }) => {
          authorize('x.memory-local.update', context);
          if (input.source === 'neo.intent') throw new ORPCError('BAD_REQUEST', { message: 'Standing intents change only through memory-local.intents' });
          // Provenance is server-assigned here too: memory-local appends who edited the entry to its existing provenance.
          const { provenance: _ignored, ...changes } = input;
          return (await invokeMemory('update', { ...changes, workspace: memoryOwner(context),
            editedBy: memoryProvenance(context) }) as Awaited<ReturnType<typeof db.memories.update>>) ?? null;
        }),
        delete: os.x['memory-local'].delete.handler(async ({ input, context }) => {
          authorize('x.memory-local.delete', context);
          return invokeMemory('delete', { ...input, workspace: memoryOwner(context) }) as Promise<{ deleted: boolean }>;
        }),
        export: os.x['memory-local'].export.handler(async ({ input, context }) => {
          authorize('x.memory-local.export', context);
          return invokeMemory('export', { workspace: memoryWorkspace(input.workspace, context) }) as ReturnType<typeof db.memories.export>;
        }),
        intents: {
          list: os.x['memory-local'].intents.list.handler(async ({ input, context }) => {
            authorize('x.memory-local.intents.list', context);
            return invokeMemory('intents/list', { workspace: memoryWorkspace(input.workspace, context) }) as ReturnType<typeof db.memories.list>;
          }),
          // Provenance is the authenticated user, never caller-supplied.
          add: os.x['memory-local'].intents.add.handler(async ({ input, context }) => {
            authorize('x.memory-local.intents.add', context);
            return invokeMemory('intents/add', { text: input.text, workspace: memoryWorkspace(input.workspace, context),
              provenance: `user:${context.user!.id} via Neo app` }) as ReturnType<typeof db.memories.add>;
          }),
          update: os.x['memory-local'].intents.update.handler(async ({ input, context }) => {
            authorize('x.memory-local.intents.update', context);
            const workspace = memoryWorkspace(input.workspace, context);
            const result = await invokeMemory('intents/update', { id: input.id, text: input.text, workspace,
              editedBy: `user:${context.user!.id} via Neo app` }) as {
                entry: Awaited<ReturnType<typeof db.memories.update>> | null; previousText?: string;
              };
            if (result.entry && result.previousText && result.previousText !== input.text &&
              kernel.hasRoute('/x/memory-honcho/forget-intent')) {
              try { await invokeHoncho('forget-intent', { workspace, text: result.previousText }); }
              catch (error) { console.error('Honcho intent cleanup failed:', error instanceof Error ? error.message : error); }
            }
            return result.entry ?? null;
          }),
          retract: os.x['memory-local'].intents.retract.handler(async ({ input, context }) => {
            authorize('x.memory-local.intents.retract', context);
            // A retracted intent also leaves Honcho, so no dream or L2 context can bring it back.
            const workspace = memoryWorkspace(input.workspace, context);
            const result = await invokeMemory('intents/retract', { id: input.id, workspace }) as { retracted: boolean; text?: string };
            if (result.retracted && result.text && kernel.hasRoute('/x/memory-honcho/forget-intent')) {
              try { await invokeHoncho('forget-intent', { workspace, text: result.text }); }
              catch (error) { console.error('Honcho intent cleanup failed:', error instanceof Error ? error.message : error); }
            }
            return { retracted: result.retracted };
          }),
        },
      },
      'engine-dsh': {
        create: os.x['engine-dsh'].create.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.create', context);
          // Server mode: the session belongs to the caller's workspace (its vault scope and model keys), never
          // to one the caller names.
          return invokeDsh('create', dshScoped(input, context)) as Promise<{ sessionId: string; pid: number }>;
        }),
        prompt: os.x['engine-dsh'].prompt.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.prompt', context);
          return invokeDsh('prompt', dshScoped(input, context)) as Promise<{ messageId: string }>;
        }),
        events: os.x['engine-dsh'].events.handler(async function* ({ input, signal, context }) {
          authorize('x.engine-dsh.events', context);
          const stream = await invokeDsh('events', dshScoped({ ...input, signal }, context)) as AsyncIterable<DshEvent>;
          yield* coalesceText(stream);
        }),
        wait: os.x['engine-dsh'].wait.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.wait', context);
          return invokeDsh('wait', dshScoped(input, context)) as Promise<{ status: 'settled' }>;
        }),
        cancel: os.x['engine-dsh'].cancel.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.cancel', context);
          return invokeDsh('cancel', dshScoped(input, context)) as Promise<{ cancelled: boolean }>;
        }),
        shutdown: os.x['engine-dsh'].shutdown.handler(async ({ input, context }) => {
          authorize('x.engine-dsh.shutdown', context);
          return invokeDsh('shutdown', dshScoped(input, context)) as Promise<{ stopped: boolean }>;
        }),
      },
      'coding-workflow': codingWorkflowRouter(kernel),
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
            authorize('x.engine-hermes.cron.update', context);
            return invokeHermes('cron/update', input) as Promise<Record<string, unknown>>;
          }),
          pause: os.x['engine-hermes'].cron.pause.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.cron.pause', context);
            return invokeHermes('cron/pause', input) as Promise<Record<string, unknown>>;
          }),
          trigger: os.x['engine-hermes'].cron.trigger.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.cron.trigger', context);
            return invokeHermes('cron/trigger', input) as Promise<Record<string, unknown>>;
          }),
          history: os.x['engine-hermes'].cron.history.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.cron.history', context);
            return invokeHermes('cron/history', input) as Promise<{ runs: Record<string, unknown>[]; limit: number }>;
          }),
          delete: os.x['engine-hermes'].cron.delete.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.cron.delete', context);
            return invokeHermes('cron/delete', input);
          }),
        },
        kanban: {
          boards: os.x['engine-hermes'].kanban.boards.handler(async ({ context }) => {
            authorize('x.engine-hermes.kanban.boards', context);
            return invokeHermes('kanban/boards', {}) as Promise<{ boards: Record<string, unknown>[]; current: string }>;
          }),
          createBoard: os.x['engine-hermes'].kanban.createBoard.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.kanban.createBoard', context);
            return invokeHermes('kanban/create-board', input) as Promise<Record<string, unknown>>;
          }),
          board: os.x['engine-hermes'].kanban.board.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.kanban.board', context);
            return invokeHermes('kanban/board', input) as Promise<{ columns: { name: string; tasks: Record<string, unknown>[] }[]; assignees: string[]; latest_event_id: number; now: number }>;
          }),
          create: os.x['engine-hermes'].kanban.create.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.kanban.create', context);
            return invokeHermes('kanban/create', input) as Promise<{ task: Record<string, unknown> | null }>;
          }),
          assign: os.x['engine-hermes'].kanban.assign.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.kanban.assign', context);
            return invokeHermes('kanban/assign', input) as Promise<{ task: Record<string, unknown> }>;
          }),
          task: os.x['engine-hermes'].kanban.task.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.kanban.task', context);
            return invokeHermes('kanban/task', input) as Promise<{ task: Record<string, unknown>; events: unknown[]; runs: unknown[] }>;
          }),
          dispatch: os.x['engine-hermes'].kanban.dispatch.handler(async ({ input, context }) => {
            authorize('x.engine-hermes.kanban.dispatch', context);
            return invokeHermes('kanban/dispatch', input) as Promise<Record<string, unknown>>;
          }),
        },
      },
    },
    extensions: {
      list: os.extensions.list.handler(async ({ context }) => {
        authorize('extensions.list', context);
        return Promise.all(kernel.list().map(withHealth));
      }),
      upgrade: os.extensions.upgrade.handler(async ({ input, context }) => {
        authorize('extensions.upgrade', context);
        const result = await kernel.upgrade(input.id, input.directory, input);
        if (result.upgraded) syncBackupVersion(input.id);
        return result;
      }),
      enable: os.extensions.enable.handler(async ({ input, context }) => {
        authorize('extensions.enable', context);
        const extension = await kernel.enable(input.id);
        if (input.id === 'engine-hermes') await agentApi.sync();
        return withHealth(extension);
      }),
      disable: os.extensions.disable.handler(async ({ input, context }) => {
        authorize('extensions.disable', context);
        if (input.id === 'engine-hermes') await agentApi.stop();
        return withHealth(await kernel.disable(input.id));
      }),
      uninstall: os.extensions.uninstall.handler(async ({ input, context }) => {
        authorize('extensions.uninstall', context);
        const extension = await kernel.uninstall(input.id);
        if (input.id === 'engine-hermes') await agentApi.stop();
        syncBackupVersion(input.id);
        return withHealth(extension);
      }),
    },
    settings: {
      get: os.settings.get.handler(async ({ input, context }) => {
        authorize('settings.get', context);
        if (!input?.extension) throw new ORPCError('BAD_REQUEST', { message: 'extension required' });
        if (!kernel.hasExtension(input.extension)) {
          throw new ORPCError('NOT_FOUND', { message: `Extension ${input.extension} not found` });
        }
        const { sanitized, schema } = await kernel.getSettings(input.extension, settingsWorkspace(context));
        return {
          extension: input.extension,
          schema,
          values: sanitized,
        };
      }),
      set: os.settings.set.handler(async ({ input, context }) => {
        const deploymentSettingsWrite = authorizeDeploymentSettingsWrite(input?.extension, context);
        if (!deploymentSettingsWrite) {
          authorize('settings.set', context, { workspaceOnly: true });
        }
        if (!input?.extension) throw new ORPCError('BAD_REQUEST', { message: 'extension required' });
        if (!kernel.hasExtension(input.extension)) {
          throw new ORPCError('NOT_FOUND', { message: `Extension ${input.extension} not found` });
        }
        const workspace = settingsWorkspace(context);
        if (!workspace && !deploymentSettingsWrite) throw new ORPCError('FORBIDDEN', { message: 'Workspace membership required' });
        let sanitized: Record<string, unknown>;
        try {
          sanitized = await kernel.saveSettings(input.extension, input.values, workspace);
        } catch (error) {
          if (error instanceof SettingsValidationError) throw new ORPCError('BAD_REQUEST', { message: error.message });
          throw error;
        }
        return {
          extension: input.extension,
          values: sanitized,
        };
      }),
    },
    vault: {
      list: os.vault.list.handler(async ({ input, context }) => {
        await authorizeVault('list', input?.scope, context);
        return vault.list(input.scope);
      }),
      put: os.vault.put.handler(async ({ input, context }) => {
        await authorizeVault('put', input?.scope, context, input?.name);
        return vault.put(input.scope, input.name, input.value);
      }),
      rotate: os.vault.rotate.handler(async ({ input, context }) => {
        await authorizeVault('rotate', input?.scope, context, input?.name);
        return vault.rotate(input.scope, input.name, input.value);
      }),
      delete: os.vault.delete.handler(async ({ input, context }) => {
        await authorizeVault('delete', input?.scope, context, input?.name);
        return { deleted: await vault.delete(input.scope, input.name) };
      }),
    },
    computers: {
      policy: {
        get: os.computers.policy.get.handler(({ input, context }) => {
          authorize('computers.policy.get', context);
          if (mode === 'server') computers.assertWorkspace(input.id, computerWorkspace(context.workspaceId)!);
          return computers.policy(input.id);
        }),
        set: os.computers.policy.set.handler(({ input, context }) => {
          authorize('computers.policy.set', context);
          if (mode === 'server') computers.assertWorkspace(input.id, computerWorkspace(context.workspaceId)!);
          return computers.setPolicy(input.id, input);
        }),
      },
      list: os.computers.list.handler(async ({ context }) => {
        authorize('computers.list', context);
        return computers.list(computerWorkspace(context.workspaceId));
      }),
      provision: os.computers.provision.handler(async ({ input, context }) => {
        authorize('computers.provision', context);
        try { return await computers.provision(input.providerId, input.spec, { workspaceId: mode === 'server' ? computerWorkspace(context.workspaceId) : context.workspaceId ?? undefined }); }
        catch { throw new ORPCError('BAD_REQUEST', { message: 'Computer provisioning failed; check the image, Docker service and workspace credentials' }); }
      }),
      attach: os.computers.attach.handler(async ({ input, context }) => {
        authorize('computers.attach', context);
        try { return await computers.attach(input.providerId, input.target, { workspaceId: mode === 'server' ? computerWorkspace(context.workspaceId) : context.workspaceId ?? undefined }); }
        catch { throw new ORPCError('BAD_REQUEST', { message: 'Computer attachment failed; check the target, security type and vault credentials' }); }
      }),
      release: os.computers.release.handler(async ({ input, context }) => {
        authorize('computers.release', context);
        return { released: await computers.release(input.id, computerWorkspace(context.workspaceId)) };
      }),
      terminate: os.computers.terminate.handler(async ({ input, context }) => {
        authorize('computers.terminate', context);
        return { terminated: await computers.terminate(input.id, computerWorkspace(context.workspaceId)) };
      }),
      lease: os.computers.lease.handler(async ({ input, context }) => {
        authorize('computers.lease', context);
        return computers.lease(input.id, input.holder, computerWorkspace(context.workspaceId));
      }),
      assign: os.computers.assign.handler(async ({ input, context }) => {
        authorize('computers.assign', context);
        const workspace = computerWorkspace(context.workspaceId);
        if (workspace) {
          computers.assertWorkspace(input.computerId, workspace);
          let owned = false;
          if (input.engine === 'hermes') {
            const normalized = /^neo_[a-f0-9]{32}$/i.test(input.targetId)
              ? input.targetId.slice(4).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
              : input.targetId;
            const bot = await db.agents.getBot(normalized);
            owned = bot?.workspace_id === workspace;
          } else if (input.engine === 'dsh') {
            const session = await invokeDsh('session/workspace', { sessionId: input.targetId }) as { workspaceId?: string };
            owned = session.workspaceId === workspace;
          } else if (input.engine === 'superagent') {
            const items = await invokeInbox('list', {}) as InboxItem[];
            owned = items.some((item) => item.botId === input.targetId && item.workspace === workspace);
            if (!owned) {
              // A superagent worker also runs for a workspace-owned bot before an Inbox item exists.
              const normalized = /^neo_[a-f0-9]{32}$/i.test(input.targetId)
                ? input.targetId.slice(4).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
                : input.targetId;
              const bot = await db.agents.getBot(normalized);
              owned = bot?.workspace_id === workspace;
            }
          }
          if (!owned) throw new ORPCError('NOT_FOUND', { message: 'Target unavailable in this workspace' });
        }
        computers.assign(input.engine, input.targetId, input.computerId, workspace);
        return input;
      }),
      kill: os.computers.kill.handler(async ({ input, context }) => {
        authorize('computers.kill', context);
        return computers.kill(input.engaged, computerWorkspace(context.workspaceId));
      }),
      state: os.computers.state.handler(async ({ context }) => {
        authorize('computers.state', context);
        return computers.state(computerWorkspace(context.workspaceId));
      }),
      capture: os.computers.capture.handler(async ({ input, context }) => {
        authorize('computers.capture', context);
        try { return await computers.capture(input.id, computerWorkspace(context.workspaceId)); }
        catch { throw new ORPCError('BAD_GATEWAY', { message: 'Computer capture failed; release and reattach the computer' }); }
      }),
      local: {
        status: os.computers.local.status.handler(async ({ context }) => {
          authorize('computers.local.status', context);
          if (!kernel.hasRoute('/x/computer-local/status')) return { available: false, enabled: false };
          const status = await kernel.invokeRoute('/x/computer-local/status', 'GET') as { enabled: boolean };
          return { available: true, enabled: status.enabled };
        }),
        set: os.computers.local.set.handler(async ({ input, context }) => {
          authorize('computers.local.set', context);
          if (!kernel.hasRoute('/x/computer-local/consent')) {
            throw new ORPCError('NOT_FOUND', { message: 'Local desktop extension is disabled' });
          }
          return await kernel.invokeRoute('/x/computer-local/consent', 'POST', input) as { enabled: boolean };
        }),
      },
    },
    events: {
      subscribe: os.events.subscribe.handler(async function* ({ input, signal, context }) {
        authorize('events.subscribe', context);
        // Settings changes are per workspace (P1-13): a server-mode subscriber only hears its own workspace's.
        for await (const event of kernel.events.subscribe(input.since, signal)) {
          if (event.type === 'settings.change' && mode !== 'desktop') {
            const visible = hasDeploymentSettings(event.extension)
              ? canSeeDeploymentItems(context) : event.workspaceId === context.workspaceId;
            if (!visible) continue;
          }
          yield event;
        }
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

      const channelInbound = /^\/internal\/channels\/([a-z][a-z0-9-]{0,31})\/inbound$/.exec(path);
      if (channelInbound) {
        // Engine callback (a channel platform's Hermes plugin). The platform owns
        // and checks its per-profile vault token; no platform attached means 404.
        const platform = channelBus.platform(channelInbound[1]!);
        if (!platform) { res.writeHead(404).end(); return; }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 65_536) { res.writeHead(413).end(); return; }
          chunks.push(chunk as Buffer);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { res.writeHead(400).end(); return; }
        try {
          const result = await platform.inbound({ authorization: req.headers.authorization, body });
          res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body ?? {}));
        } catch (error) {
          console.error('Channel inbound failed:', error instanceof Error ? error.message : error);
          res.writeHead(500).end();
        }
        return;
      }

      if (path === '/internal/memory/context' || path === '/internal/memory/soul' || path === '/internal/memory/write') {
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
        const expected = await vault.get(memoryScope(consumer), MEMORY_TOKEN);
        if (!provided || !expected || !timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))) {
          res.writeHead(401).end(); return;
        }
        if (path === '/internal/memory/soul') {
          const scoped = await invokeMemory('list', { workspace: consumer.workspace, query: '' }) as Array<{
            text: string; subject: 'user' | 'bot'; subject_id: string;
          }>;
          const soul = scoped.filter((entry) => entry.subject === 'bot'
            && (entry.subject_id === 'neo-coding' || entry.subject_id === 'global'))
            .slice(0, 12).map((entry) => entry.text).join('\n').slice(0, 4000);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ soul }));
        } else if (!writing) {
          const query = (url.searchParams.get('q') ?? '').slice(0, 500);
          const scoped = await invokeMemory('list', { workspace: consumer.workspace, query }) as Array<{
            text: string; source: string; trust: string; subject: 'user' | 'bot'; subject_id: string;
          }>;
          const entries = scoped.filter((entry) => (entry.subject_id === 'global' || entry.subject_id === name)
            && entry.source !== 'neo.intent');
          const localContext = entries.slice(0, 15)
            .map((entry) => '- ' + entry.text + ' [' + entry.source + '; ' + entry.trust + ']')
            .join('\n').slice(0, 2800);
          // Standing intents ride along on every turn, whatever the query; only confirmed ones count.
          const intents = (await invokeMemory('intents/list', { workspace: consumer.workspace }) as Array<{
            text: string; trust: string; provenance: string;
          }>).filter((entry) => entry.trust === 'confirmed').slice(0, 20);
          // Provenance (a user id) stays in Neo; model providers only see that the intent is confirmed.
          const intentContext = intents.length ? ('Standing intents:\n' + intents.map((entry) =>
            '- ' + entry.text.replace(/\s+/g, ' ').slice(0, 300) + ' [standing intent; confirmed]').join('\n')).slice(0, 1500) : '';
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
          const context = [intentContext, localContext, honchoContext].filter(Boolean).join('\n').slice(0, 6000);
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

      if (path === '/internal/computers-mcp/action') {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        if (!kernel.hasRoute('/x/computers-mcp/action')) { res.writeHead(404).end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 16384) { res.writeHead(413).end(); return; }
          chunks.push(chunk as Buffer);
        }
        let payload: unknown;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { res.writeHead(400).end(); return; }
        const result = await kernel.invokeRoute('/x/computers-mcp/action', 'POST', { authorization: req.headers.authorization, payload }) as { status: number; body: unknown };
        res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
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
        const context = await resolveGatewayAuth(req);
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
        if (mode === 'server' && req.method === 'POST' && path.replace(/\/+$/, '') === '/auth/organization/create') {
          authorize('/auth/organization/create', await resolveGatewayAuth(req));
        }
        await authNodeHandler(req, res);
        return;
      }

      const context = await resolveGatewayAuth(req);
      if (!context?.user) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (path.startsWith('/x/coding-workflow/') || path.startsWith('/x/models-router-panda/') || path.startsWith('/x/engine-t3/') || path.startsWith('/x/engine-hermes/') || path.startsWith('/x/engine-dsh/') || path.startsWith('/x/engine-superagent/') || path.startsWith('/x/memory-local/') || path.startsWith('/x/memory-honcho/') || path.startsWith('/x/skills-registry/') || path.startsWith('/x/models/') || path.startsWith('/x/channels/') || path.startsWith('/x/metrics/')) {
        // Order for every role: authorize the procedure, then report availability,
        // then let oRPC validate method and input. Authorization runs before
        // anything else, so no role learns more than its policy allows, and a
        // disabled engine answers 404 whatever the request body or method.
        const procedure = path.slice(1).split('/').join('.');
        if (CONTRACT_POLICY[procedure]) {
          authorize(procedure, context as GatewayAuthContext);
          // Deployment configuration procedures are served by the same extension routes.
          const extensionPath = path.replace(/^\/x\/(models|models-router-panda)\/deployment\//, '/x/$1/')
            .replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
          // Existing Honcho and Channels procedures report their own disabled state.
          // Destination resolution requires a live Channels extension.
          const selfReporting = path === '/x/memory-honcho/status' || path === '/x/memory-honcho/list' || (path.startsWith('/x/channels/') && path !== '/x/channels/notification/resolve');
          if (!selfReporting && !kernel.hasRoute(extensionPath)) {
            res.writeHead(404).end();
            return;
          }
        }
        const matched = await kernel.runInWorkspace(settingsWorkspace(context as GatewayAuthContext),
          () => httpRPC.handle(req, res, { context: context as GatewayAuthContext }));
        if (!matched.matched) res.writeHead(404).end();
        return;
      }

      const backupRoute = path === '/x/backup/backup' || path === '/x/backup/restore';
      if (backupRoute) authorize(path, context);
      if (kernel.hasRoute(path)) {
        if (!context?.user) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (!backupRoute) authorize(path, context as GatewayAuthContext);
        if (req.method !== 'GET') {
          res.writeHead(405).end();
          return;
        }
        const result = await kernel.runInWorkspace(settingsWorkspace(context as GatewayAuthContext),
          () => kernel.invokeRoute(path, 'GET'));
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

      const matched = await kernel.runInWorkspace(settingsWorkspace(context as GatewayAuthContext),
        () => httpRPC.handle(req, res, { context: context as GatewayAuthContext }));
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
      context = (await resolveGatewayAuth({
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
