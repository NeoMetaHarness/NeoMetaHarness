import { DatabaseSync } from 'node:sqlite';
import { Kysely } from 'kysely';
import { betterAuth } from 'better-auth';
import { organization, bearer } from 'better-auth/plugins';
import { defaultAc, defaultRoles } from 'better-auth/plugins/organization/access';
import { apiKey } from '@better-auth/api-key';
import { getMigrations } from 'better-auth/db/migration';
import { createNodeSqliteKysely } from '@neometaharness/db';
import crypto from 'node:crypto';

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
  db?: Kysely<any>;
  sqlite?: DatabaseSync;
  baseURL?: string;
  secret?: string;
}

export function createNeoAuth(options: CreateNeoAuthOptions = {}): any {
  let kysely = options.db;
  let sqlite = options.sqlite;
  if (!kysely) {
    sqlite = sqlite ?? new DatabaseSync(':memory:');
    kysely = createNodeSqliteKysely(sqlite);
  }

  const auth = betterAuth({
    baseURL: options.baseURL ?? 'http://127.0.0.1:3000',
    secret: options.secret ?? 'neo-meta-harness-auth-secret-key-32-chars-min',
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
      }) as any,
      bearer() as any,
      apiKey({
        enableMetadata: true,
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
}

export interface BootstrapResult {
  user: { id: string; email: string; name?: string };
  workspace: { id: string; name: string; slug: string };
  token: string;
  session: { id: string; token: string; expiresAt: Date | string };
  bootstrapped: boolean;
}

export async function bootstrapDesktopAuth(
  auth: any,
  options: {
    email?: string;
    password?: string;
    name?: string;
    workspaceName?: string;
    workspaceSlug?: string;
  } = {}
): Promise<BootstrapResult> {
  const kysely: Kysely<any> = auth.kysely;
  const email = options.email ?? 'local.owner@neo.local';
  const password = options.password ?? 'DesktopOwnerPass!123';
  const name = options.name ?? 'Desktop Local Owner';
  const workspaceName = options.workspaceName ?? 'Local Workspace';
  const workspaceSlug = options.workspaceSlug ?? 'local-workspace';

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

    return {
      user: { id: ownerUser.id, email: ownerUser.email, name: ownerUser.name },
      workspace: org
        ? { id: org.id, name: org.name, slug: org.slug }
        : { id: 'default', name: 'Default', slug: 'default' },
      token: sessionToken,
      session: {
        id: sessionId,
        token: sessionToken,
        expiresAt,
      },
      bootstrapped: false,
    };
  }

  // First time bootstrap: create owner user
  const signupRes = await auth.api.signUpEmail({
    body: {
      email,
      password,
      name,
    },
  });

  const ownerUser = signupRes.user;
  const ownerToken = signupRes.token;

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

  return {
    user: { id: ownerUser.id, email: ownerUser.email, name: ownerUser.name },
    workspace: { id: org.id, name: org.name, slug: org.slug },
    token: ownerToken,
    session: signupRes.session,
    bootstrapped: true,
  };
}

export async function resolveAuthContext(
  auth: any,
  headers: Headers,
  options: {
    mode?: string;
    isLoopback?: boolean;
    bootstrapContext?: NeoAuthContext | null;
  } = {}
): Promise<NeoAuthContext> {
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
        const key = verifyRes.key;
        const meta = (key.metadata ?? {}) as Record<string, unknown>;
        const workspaceId = (meta.workspaceId as string) ?? (key.organizationId as string) ?? null;
        const role = (meta.role as NeoRole) ?? 'member';
        return {
          user: { id: key.userId ?? 'api-key-user', email: '', name: key.name },
          session: null,
          workspaceId,
          role,
          apiKey: { id: key.id, name: key.name, metadata: meta },
        };
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
              role = (firstMember.role as NeoRole) ?? 'member';
            }
          } else {
            const member = (await kysely
              .selectFrom('member')
              .selectAll()
              .where('userId', '=', sessionRes.user.id)
              .where('organizationId', '=', workspaceId)
              .executeTakeFirst()) as any;
            role = (member?.role as NeoRole) ?? 'member';
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
        const key = verifyRes.key;
        const meta = (key.metadata ?? {}) as Record<string, unknown>;
        const workspaceId = (meta.workspaceId as string) ?? (key.organizationId as string) ?? null;
        const role = (meta.role as NeoRole) ?? 'member';
        return {
          user: { id: key.userId ?? 'api-key-user', email: '', name: key.name },
          session: null,
          workspaceId,
          role,
          apiKey: { id: key.id, name: key.name, metadata: meta },
        };
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
              role = (firstMember.role as NeoRole) ?? 'member';
            }
          } else {
            const member = (await kysely
              .selectFrom('member')
              .selectAll()
              .where('userId', '=', sessionRes.user.id)
              .where('organizationId', '=', workspaceId)
              .executeTakeFirst()) as any;
            role = (member?.role as NeoRole) ?? 'member';
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

  // 4. Desktop mode loopback fallback (for unauthenticated local calls)
  const isDesktop = (options.mode ?? process.env.NEO_MODE ?? 'desktop') === 'desktop';
  if (isDesktop && options.isLoopback && options.bootstrapContext) {
    return options.bootstrapContext;
  }

  return { user: null, session: null, workspaceId: null, role: null };
}
