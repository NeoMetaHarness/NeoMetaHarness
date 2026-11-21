import { writeFileSync, linkSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Kysely } from 'kysely';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { organization, bearer } from 'better-auth/plugins';
import { defaultAc, defaultRoles } from 'better-auth/plugins/organization/access';
import { apiKey } from '@better-auth/api-key';
import { getMigrations } from 'better-auth/db/migration';
import { createNodeSqliteKysely } from '@neometaharness/db';
import crypto from 'node:crypto';
import { deploymentOwnerId, migrateDeploymentOwner } from './deployment-owner.js';
export { deploymentOwnerLookup, transferDeploymentOwner } from './deployment-owner.js';

export type NeoAuth = any;

export type NeoRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface NeoAuthContext {
  user: { id: string; email: string; name?: string } | null;
  session: { id: string; token?: string; expiresAt?: Date | string } | null;
  workspaceId: string | null;
  role: NeoRole | null;
  apiKey?: {
    id: string;
    name?: string;
    metadata?: Record<string, unknown>;
  } | null;
}

export const viewerRole = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ['read'],
});

export interface CreateNeoAuthOptions {
  mode?: 'server' | 'desktop';
  db?: Kysely<any>;
  sqlite?: DatabaseSync;
  baseURL?: string;
  basePath?: string;
  secret?: string;
  trustedOrigins?: string[];
  /**
   * Decides whether an HTTP sign-up may proceed. Server-side `auth.api` calls
   * (bootstrap, tests) are trusted and bypass it. Omitted means open sign-up.
   */
  signUpGate?: (request: { email: string; headers: Headers }) => boolean | Promise<boolean>;
}

export function createNeoAuth(options: CreateNeoAuthOptions = {}): any {
  if (!options?.secret) {
    throw new Error('options.secret is required for createNeoAuth');
  }

  let kysely = options.db;
  let sqlite = options.sqlite;
  if (!kysely) {
    sqlite = sqlite ?? new DatabaseSync(':memory:');
    kysely = createNodeSqliteKysely(sqlite);
  }

  const auth = betterAuth({
    baseURL: options.baseURL ?? 'http://127.0.0.1:3000',
    basePath: options.basePath ?? '/auth',
    secret: options.secret,
    trustedOrigins: options.trustedOrigins ?? [
      'http://127.0.0.1:*',
      'http://localhost:*',
      'https://tauri.localhost',
      'tauri://localhost',
    ],
    advanced: {
      disableCSRFCheck: true,
    },
    hooks: {
      before: createAuthMiddleware(async (ctx: any) => {
        const gate = options.signUpGate;
        if (!gate || !ctx.path?.startsWith('/sign-up') || !ctx.request) return;
        const email = typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
        if (!email || !(await gate({ email, headers: ctx.request.headers ?? ctx.headers ?? new Headers() }))) {
          throw new APIError('FORBIDDEN', { message: 'Sign-up requires an invitation or the setup token' });
        }
      }),
    },
    database: {
      db: kysely,
      type: 'sqlite',
    },
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      organization({
        roles: {
          ...defaultRoles,
          viewer: viewerRole,
        },
        allowUserToCreateOrganization: async (user: { id: string }) => {
          if (options.mode !== 'desktop') return (await deploymentOwnerId(kysely!)) === user.id;
          const anyWorkspace = await kysely!.selectFrom('organization').select('id').executeTakeFirst();
          if (!anyWorkspace) return true;
          const privileged = await kysely!.selectFrom('member').select('id')
            .where('userId', '=', user.id).where('role', 'in', ['owner', 'admin']).executeTakeFirst();
          return Boolean(privileged);
        },
      }) as any,
      bearer() as any,
      apiKey({
        enableMetadata: true,
        rateLimit: {
          enabled: false,
        },
        keyExpiration: {
          minExpiresIn: 0,
          maxExpiresIn: 365,
        },
      }) as any,
    ],
  });

  return Object.assign(auth, { kysely, sqlite });
}

export async function migrateAuthSchema(auth: any): Promise<void> {
  const mig = await getMigrations(auth.options);
  await mig.runMigrations();
  await migrateDeploymentOwner(auth.kysely);
}

export interface BootstrapResult {
  user: { id: string; email: string; name?: string };
  workspace: { id: string; name: string; slug: string };
  token: string;
  sessionToken: string;
  session: { id: string; token: string; expiresAt: Date | string };
  bootstrapped: boolean;
}


function saveDesktopToken(dataDir: string | undefined, token: string): void {
  if (!dataDir) return;
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = join(dataDir, 'desktop.token');
  const tmpPath = `${tokenPath}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmpPath, token, { encoding: 'utf8', mode: 0o600 });
  try {
    linkSync(tmpPath, tokenPath);
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      try { unlinkSync(tokenPath); } catch {}
      linkSync(tmpPath, tokenPath);
    } else {
      throw err;
    }
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

export async function bootstrapDesktopAuth(
  auth: any,
  options: {
    dataDir?: string;
    email?: string;
    password?: string;
    name?: string;
    workspaceName?: string;
    workspaceSlug?: string;
  } = {}
): Promise<BootstrapResult> {
  const kysely: Kysely<any> = auth.kysely;
  const email = options.email ?? 'owner@neo.local';
  const password = options.password ?? crypto.randomBytes(32).toString('hex');
  const name = options.name ?? 'Desktop Owner';
  const workspaceName = options.workspaceName ?? 'Default Workspace';
  const workspaceSlug = options.workspaceSlug ?? 'default';

  // Revoke prior 'Neo-Desktop/1.0' sessions so session table doesn't grow forever
  await kysely
    .deleteFrom('session')
    .where('userAgent', '=', 'Neo-Desktop/1.0')
    .execute();

  // Check if any user already exists
  const existingUsers = await kysely.selectFrom('user').selectAll().execute();
  if (existingUsers && existingUsers.length > 0) {
    const ownerUser = (existingUsers.find((u: any) => u.email === email) ?? existingUsers[0]) as any;
    const existingOrgs = await kysely.selectFrom('organization').selectAll().execute();
    const org = (existingOrgs && existingOrgs.length > 0 ? existingOrgs[0] : null) as any;

    // Create a new session token for the existing owner
    const sessionToken = `neo_desk_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const nowIso = new Date().toISOString();
    const sessionId = crypto.randomUUID();

    await kysely
      .insertInto('session')
      .values({
        id: sessionId,
        token: sessionToken,
        userId: ownerUser.id,
        activeOrganizationId: org?.id ?? null,
        expiresAt,
        createdAt: nowIso,
        updatedAt: nowIso,
        ipAddress: '127.0.0.1',
        userAgent: 'Neo-Desktop/1.0',
      })
      .execute();

    saveDesktopToken(options.dataDir, sessionToken);
    return {
      user: { id: ownerUser.id, email: ownerUser.email, name: ownerUser.name },
      workspace: org
        ? { id: org.id, name: org.name, slug: org.slug }
        : { id: 'default', name: 'Default', slug: 'default' },
      token: sessionToken,
      sessionToken,
      session: {
        id: sessionId,
        token: sessionToken,
        expiresAt,
      },
      bootstrapped: false,
    };
  }

  // First time bootstrap: create owner user with random unguessable password
  const signupRes = await auth.api.signUpEmail({
    body: {
      email,
      password,
      name,
    },
  });

  const ownerUser = signupRes.user;
  const ownerToken = signupRes.token;

  // Mark session with userAgent: 'Neo-Desktop/1.0'
  await kysely
    .updateTable('session')
    .set({ userAgent: 'Neo-Desktop/1.0' })
    .where('token', '=', ownerToken)
    .execute();

  // Create organization
  const org = await auth.api.createOrganization({
    body: {
      name: workspaceName,
      slug: workspaceSlug,
    },
    headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
  });

  // Set active organization
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
  });

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  saveDesktopToken(options.dataDir, ownerToken);
  return {
    user: { id: ownerUser.id, email: ownerUser.email, name: ownerUser.name },
    workspace: { id: org.id, name: org.name, slug: org.slug },
    token: ownerToken,
    sessionToken: ownerToken,
    session: {
      id: ownerUser.id,
      token: ownerToken,
      expiresAt,
    },
    bootstrapped: true,
  };
}

function toHeaders(input: any): Headers {
  if (input instanceof Headers) return input;
  if (input?.headers instanceof Headers) return input.headers;
  const raw = input?.headers ?? input ?? {};
  const headers = new Headers();
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      for (const item of val) headers.append(key, item);
    } else {
      headers.set(key, String(val));
    }
  }
  return headers;
}

const ROLE_RANK: Record<NeoRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const DENIED: NeoAuthContext = { user: null, session: null, workspaceId: null, role: null };

/**
 * API key metadata is caller-supplied (any session may POST /auth/api-key/create),
 * so metadata.role can only narrow authority. The effective role is the lower of
 * the declared role and the key owner's actual membership in the declared workspace.
 */
async function apiKeyContext(kysely: Kysely<any> | undefined, key: any): Promise<NeoAuthContext> {
  const meta = (key.metadata ?? {}) as Record<string, unknown>;
  const workspaceId = (meta.workspaceId as string) ?? (key.organizationId as string) ?? null;
  const declared = meta.role as NeoRole;
  // @better-auth/api-key stores the owning user as referenceId (older shapes: userId).
  const userId = (key.referenceId ?? key.userId) as string | undefined;
  if (!(declared in ROLE_RANK) || !userId || !workspaceId || !kysely) return DENIED;
  const member = await kysely.selectFrom('member').select('role')
    .where('userId', '=', userId).where('organizationId', '=', workspaceId)
    .executeTakeFirst() as { role?: NeoRole } | undefined;
  const held = member?.role;
  if (!held || !(held in ROLE_RANK)) return DENIED;
  const role = ROLE_RANK[declared] <= ROLE_RANK[held] ? declared : held;
  return {
    user: { id: userId, email: '', name: key.name },
    session: null,
    workspaceId,
    role,
    apiKey: { id: key.id, name: key.name, metadata: meta },
  };
}

export async function resolveAuthContext(
  auth: any,
  headersInput: any,
  _options: {
    mode?: string;
  } = {}
): Promise<NeoAuthContext> {
  const headers = toHeaders(headersInput);
  const kysely: Kysely<any> = auth.kysely;
  const authHeader = headers.get('authorization');
  const apiKeyHeader = headers.get('x-api-key');
  const cookieHeader = headers.get('cookie');

  // 1. Explicit API key in header (x-api-key)
  if (apiKeyHeader) {
    try {
      const verifyRes = await auth.api.verifyApiKey({
        body: { key: apiKeyHeader },
      });
      if (verifyRes?.valid && verifyRes?.key) {
        return await apiKeyContext(kysely, verifyRes.key);
      }
    } catch {
      // invalid or expired key
    }
    return { user: null, session: null, workspaceId: null, role: null };
  }

  // 2. Authorization header: Bearer <token>
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();

    // Check if token is a Better Auth session
    try {
      const sessionRes = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      if (sessionRes?.session && sessionRes?.user) {
        let workspaceId = sessionRes.session.activeOrganizationId ?? null;
        let role: NeoRole | null = null;

        if (kysely) {
          if (!workspaceId) {
            const firstMember = (await kysely
              .selectFrom('member')
              .selectAll()
              .where('userId', '=', sessionRes.user.id)
              .executeTakeFirst()) as any;
            if (firstMember) {
              workspaceId = firstMember.organizationId;
              role = (firstMember.role as NeoRole) ?? null;
            } else {
              role = null;
            }
          } else {
            const member = (await kysely
              .selectFrom('member')
              .selectAll()
              .where('userId', '=', sessionRes.user.id)
              .where('organizationId', '=', workspaceId)
              .executeTakeFirst()) as any;
            role = member ? ((member.role as NeoRole) ?? null) : null;
          }
        }

        return {
          user: {
            id: sessionRes.user.id,
            email: sessionRes.user.email,
            name: sessionRes.user.name,
          },
          session: {
            id: sessionRes.session.id,
            token,
            expiresAt: sessionRes.session.expiresAt,
          },
          workspaceId,
          role,
        };
      }
    } catch {
      // not a session
    }

    // Check if Bearer token is an API key
    try {
      const verifyRes = await auth.api.verifyApiKey({
        body: { key: token },
      });
      if (verifyRes?.valid && verifyRes?.key) {
        return await apiKeyContext(kysely, verifyRes.key);
      }
    } catch {
      // not an api key either
    }

    // Explicit Bearer token was provided but failed verification
    return { user: null, session: null, workspaceId: null, role: null };
  }

  // 3. Cookie session
  if (cookieHeader) {
    try {
      const sessionRes = await auth.api.getSession({
        headers: new Headers({ cookie: cookieHeader }),
      });
      if (sessionRes?.session && sessionRes?.user) {
        let workspaceId = sessionRes.session.activeOrganizationId ?? null;
        let role: NeoRole | null = null;

        if (kysely) {
          if (!workspaceId) {
            const firstMember = (await kysely
              .selectFrom('member')
              .selectAll()
              .where('userId', '=', sessionRes.user.id)
              .executeTakeFirst()) as any;
            if (firstMember) {
              workspaceId = firstMember.organizationId;
              role = (firstMember.role as NeoRole) ?? null;
            } else {
              role = null;
            }
          } else {
            const member = (await kysely
              .selectFrom('member')
              .selectAll()
              .where('userId', '=', sessionRes.user.id)
              .where('organizationId', '=', workspaceId)
              .executeTakeFirst()) as any;
            role = member ? ((member.role as NeoRole) ?? null) : null;
          }
        }

        return {
          user: {
            id: sessionRes.user.id,
            email: sessionRes.user.email,
            name: sessionRes.user.name,
          },
          session: {
            id: sessionRes.session.id,
            expiresAt: sessionRes.session.expiresAt,
          },
          workspaceId,
          role,
        };
      }
    } catch {
      // invalid cookie
    }
  }

  // No ambient authority. Unauthenticated requests have null identity.
  return { user: null, session: null, workspaceId: null, role: null };
}

export function requireViewer(context?: NeoAuthContext): void {
  if (!context?.user) {
    const error: any = new Error('Authentication required');
    error.code = 'UNAUTHORIZED';
    error.status = 401;
    throw error;
  }
  if (!context.role) {
    const error: any = new Error('Workspace membership required');
    error.code = 'FORBIDDEN';
    error.status = 403;
    throw error;
  }
}

export function requireMember(context?: NeoAuthContext): void {
  if (!context?.user) {
    const error: any = new Error('Authentication required');
    error.code = 'UNAUTHORIZED';
    error.status = 401;
    throw error;
  }
  if (!context.role || context.role === 'viewer') {
    const error: any = new Error('Member role required');
    error.code = 'FORBIDDEN';
    error.status = 403;
    throw error;
  }
}

export function requireAdminOrOwner(context?: NeoAuthContext): void {
  if (!context?.user) {
    const error: any = new Error('Authentication required');
    error.code = 'UNAUTHORIZED';
    error.status = 401;
    throw error;
  }
  if (!context.role || (context.role !== 'owner' && context.role !== 'admin')) {
    const error: any = new Error('Admin or owner role required');
    error.code = 'FORBIDDEN';
    error.status = 403;
    throw error;
  }
}

export function requireOwner(context?: NeoAuthContext): void {
  if (!context?.user) {
    const error: any = new Error('Authentication required');
    error.code = 'UNAUTHORIZED';
    error.status = 401;
    throw error;
  }
  if (!context.role || context.role !== 'owner') {
    const error: any = new Error('Owner role required');
    error.code = 'FORBIDDEN';
    error.status = 403;
    throw error;
  }
}
