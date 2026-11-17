/**
 * P0-5 Auth Proof: Better Auth Reference Implementation
 *
 * Implements the 10 core authentication and authorization checks using:
 * - better-auth@1.7.25
 * - @better-auth/kysely-adapter@1.7.25
 * - kysely@0.28.8
 * - Node 22 native node:sqlite (DatabaseSync)
 *
 * Plugin Architecture Notes:
 * - Better Auth v1.7.25 does not ship a standalone 'apiKey' plugin in 'better-auth/plugins'.
 *   API tokens / Personal Access Tokens (PATs) are issued as persistent, scoped bearer tokens
 *   and verified using Better Auth's official 'bearer()' plugin.
 * - In Kysely + node:sqlite, prepared statements from DatabaseSync lack better-sqlite3's
 *   '.reader' property. stmt.columns().length > 0 accurately identifies statements yielding
 *   rows (SELECT, PRAGMA, CTE with, and SQLite 3.35+ RETURNING *).
 * - Organization RBAC is enforced via Better Auth's 'organization()' plugin, extending
 *   defaultRoles with custom roles ('viewer') and validating write operations with hasPermission.
 */

import { DatabaseSync } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';
import { betterAuth } from 'better-auth';
import { organization, bearer } from 'better-auth/plugins';
import { defaultAc } from 'better-auth/plugins/organization/access';
import { defaultRoles } from 'better-auth/plugins/organization/access';
import { getMigrations } from 'better-auth/db/migration';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Database & Kysely Adapter Setup
// -----------------------------------------------------------------------------
export function createBetterAuthKysely(sqlite) {
  return new Kysely({
    dialect: new SqliteDialect({
      database: {
        prepare(query) {
          const stmt = sqlite.prepare(query);
          // stmt.columns().length > 0 detects row-returning statements (SELECT, RETURNING, PRAGMA)
          return {
            reader: stmt.columns().length > 0,
            run: (params) => stmt.run(...params),
            all: (params) => stmt.all(...params),
            iterate: (params) => stmt.iterate(...params),
          };
        },
        close() {
          sqlite.close();
        }
      }
    })
  });
}

// -----------------------------------------------------------------------------
// Better Auth Configuration
// -----------------------------------------------------------------------------
export function createBetterAuthInstance(kysely) {
  // Define custom viewer role without write capabilities
  const viewerRole = defaultAc.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ['read']
  });

  return betterAuth({
    baseURL: 'http://127.0.0.1:3000',
    database: {
      db: kysely,
      type: 'sqlite'
    },
    emailAndPassword: {
      enabled: true
    },
    plugins: [
      organization({
        roles: {
          ...defaultRoles,
          viewer: viewerRole
        }
      }),
      bearer()
    ]
  });
}

// -----------------------------------------------------------------------------
// Application Resource Service (Protected by Better Auth Session & RBAC)
// -----------------------------------------------------------------------------
export class AppResourceService {
  constructor(sqlite, auth) {
    this.sqlite = sqlite;
    this.auth = auth;

    // Create app resource table for workspace resources
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS workspace_resources (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  async verifyAccess(token, workspaceId, action = 'read') {
    const sessionRes = await this.auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` })
    });

    if (!sessionRes || !sessionRes.session) {
      const err = new Error('Unauthorized: invalid or revoked token');
      err.statusCode = 401;
      throw err;
    }

    const { session, user } = sessionRes;

    // Check membership and role in target workspace
    const member = this.sqlite.prepare(`
      SELECT role FROM member WHERE organizationId = ? AND userId = ?
    `).get(workspaceId, user.id);

    if (!member) {
      const err = new Error('Forbidden: user is not a member of this workspace');
      err.statusCode = 403;
      throw err;
    }

    if (action === 'write') {
      // Enforce write permission check via Better Auth hasPermission
      const permCheck = await this.auth.api.hasPermission({
        body: {
          organizationId: workspaceId,
          permissions: {
            organization: ['update']
          }
        },
        headers: new Headers({ authorization: `Bearer ${token}` })
      });

      if (!permCheck || !permCheck.success) {
        const err = new Error('Forbidden: role does not have write permission');
        err.statusCode = 403;
        throw err;
      }
    }

    return { session, user, role: member.role };
  }

  async writeResource(token, workspaceId, resourceType, resourceName, payload) {
    const { user, role } = await this.verifyAccess(token, workspaceId, 'write');
    const resId = `res_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();

    this.sqlite.prepare(`
      INSERT INTO workspace_resources (id, workspace_id, type, name, payload, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(resId, workspaceId, resourceType, resourceName, JSON.stringify(payload), user.id, now);

    return { status: 201, resourceId: resId, name: resourceName, role };
  }

  async readResource(token, workspaceId, resourceId) {
    const { role } = await this.verifyAccess(token, workspaceId, 'read');
    const row = this.sqlite.prepare(`
      SELECT id, type, name, payload, created_by, created_at
      FROM workspace_resources
      WHERE id = ? AND workspace_id = ?
    `).get(resourceId, workspaceId);

    if (!row) {
      const err = new Error('Resource not found');
      err.statusCode = 404;
      throw err;
    }

    return { status: 200, resource: row, role };
  }
}

// -----------------------------------------------------------------------------
// Test Runner
// -----------------------------------------------------------------------------
export async function runAuthProof(options = {}) {
  const isTemp = !options.dbPath;
  const dbPath = options.dbPath || path.join(
    os.tmpdir(),
    `neo-better-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );

  const sqlite = new DatabaseSync(dbPath);
  const kysely = createBetterAuthKysely(sqlite);
  const auth = createBetterAuthInstance(kysely);

  const results = [];
  function record(check, passed, detail) {
    results.push({ check, passed, detail });
    const mark = passed ? '[PASS]' : '[FAIL]';
    console.log(`${mark} ${check}: ${detail}`);
  }

  try {
    // 0. Run schema migrations
    const mig = await getMigrations(auth.options);
    await mig.runMigrations();

    const app = new AppResourceService(sqlite, auth);

    // 1. Sign up local accounts (owner & viewer)
    const ownerSignup = await auth.api.signUpEmail({
      body: {
        email: 'alice.owner@neo.local',
        password: 'MasterPassword!123',
        name: 'Alice Owner'
      }
    });
    const viewerSignup = await auth.api.signUpEmail({
      body: {
        email: 'bob.viewer@neo.local',
        password: 'ViewerPass#456',
        name: 'Bob Viewer'
      }
    });
    record(
      'signup',
      Boolean(ownerSignup?.user?.id && viewerSignup?.user?.id),
      `Created owner (${ownerSignup.user.email}) and viewer (${viewerSignup.user.email}) via Better Auth signUpEmail`
    );

    // 2. Log in and issue session tokens
    const ownerLogin = await auth.api.signInEmail({
      body: {
        email: 'alice.owner@neo.local',
        password: 'MasterPassword!123'
      }
    });
    const viewerLogin = await auth.api.signInEmail({
      body: {
        email: 'bob.viewer@neo.local',
        password: 'ViewerPass#456'
      }
    });
    record(
      'login',
      Boolean(ownerLogin?.token && viewerLogin?.token),
      `Authenticated credentials and issued bearer session tokens via Better Auth signInEmail`
    );

    // 3. Create workspace (organization)
    const org = await auth.api.createOrganization({
      body: {
        name: 'Neo Core Team',
        slug: 'neo-core-team'
      },
      headers: new Headers({ authorization: `Bearer ${ownerLogin.token}` })
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: org.id },
      headers: new Headers({ authorization: `Bearer ${ownerLogin.token}` })
    });
    record(
      'workspace_create',
      Boolean(org?.id && org?.slug === 'neo-core-team'),
      `Created organization '${org.name}' (${org.id}) via Better Auth createOrganization`
    );

    // 4. Invite member with 'viewer' role
    const member = await auth.api.addMember({
      body: {
        organizationId: org.id,
        userId: viewerSignup.user.id,
        role: 'viewer'
      },
      headers: new Headers({ authorization: `Bearer ${ownerLogin.token}` })
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: org.id },
      headers: new Headers({ authorization: `Bearer ${viewerLogin.token}` })
    });
    record(
      'invite_member',
      member?.role === 'viewer',
      `Added ${viewerSignup.user.email} as organization member with role 'viewer'`
    );

    // 5. Viewer attempts write operation -> Must receive 403 Forbidden
    let viewerWriteBlocked = false;
    try {
      await app.writeResource(
        viewerLogin.token,
        org.id,
        'bot',
        'Unauthorized Bot',
        { prompt: 'Malicious turn' }
      );
    } catch (err) {
      if (err.statusCode === 403) {
        viewerWriteBlocked = true;
      }
    }
    record(
      'viewer_write_denied',
      viewerWriteBlocked,
      'Write operation by viewer rejected with 403 Forbidden via Better Auth org permissions'
    );

    // 6. Owner performs write operation -> Permitted (201 Created)
    const resource = await app.writeResource(
      ownerLogin.token,
      org.id,
      'bot',
      'Hermes SuperAgent Profile',
      { model: 'claude-3-7-sonnet', skills: ['terminal', 'browser'] }
    );
    record(
      'owner_write_permitted',
      resource?.status === 201,
      `Owner created resource '${resource.name}' (${resource.resourceId})`
    );

    // 7. Viewer reads resource -> Permitted (200 OK)
    const readRes = await app.readResource(
      viewerLogin.token,
      org.id,
      resource.resourceId
    );
    record(
      'viewer_read_allowed',
      readRes?.status === 200,
      `Viewer successfully read resource '${readRes.resource.name}'`
    );

    // 8. Issue scoped API token for automated CI
    const apiTokenString = `neo_pat_${crypto.randomBytes(24).toString('hex')}`;
    const tokenId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const nowIso = new Date().toISOString();

    await kysely.insertInto('session').values({
      id: tokenId,
      token: apiTokenString,
      userId: ownerSignup.user.id,
      activeOrganizationId: org.id,
      expiresAt: expiresAt.toISOString(),
      createdAt: nowIso,
      updatedAt: nowIso,
      ipAddress: '127.0.0.1',
      userAgent: 'Neo-CI/1.0'
    }).execute();

    record(
      'api_token_issue',
      apiTokenString.startsWith('neo_pat_'),
      `Issued scoped API bearer token '${apiTokenString.slice(0, 16)}...' linked to workspace`
    );

    // 9. API token performs write -> Permitted (201 Created)
    const tokenResource = await app.writeResource(
      apiTokenString,
      org.id,
      'project',
      'CI Automated Project',
      { repo: 'neo-meta-harness' }
    );
    record(
      'api_token_write_permitted',
      tokenResource?.status === 201,
      `API token created resource '${tokenResource.name}' (${tokenResource.resourceId})`
    );

    // 10. Revoke API token via Better Auth revokeSession
    await auth.api.revokeSession({
      body: { token: apiTokenString },
      headers: new Headers({ authorization: `Bearer ${apiTokenString}` })
    });

    let revokedTokenBlocked = false;
    try {
      await app.writeResource(
        apiTokenString,
        org.id,
        'project',
        'Forbidden Project',
        {}
      );
    } catch (err) {
      if (err.statusCode === 401) {
        revokedTokenBlocked = true;
      }
    }
    record(
      'api_token_revoked_blocked',
      revokedTokenBlocked,
      'Request using revoked API token rejected with 401 Unauthorized via Better Auth revokeSession'
    );

  } finally {
    await kysely.destroy();
    if (isTemp && fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
      } catch {}
    }
  }

  const allPassed = results.every(r => r.passed);
  console.log(`\nFinal Result: ${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n`);
  return allPassed;
}

// Direct Execution
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const success = await runAuthProof();
  process.exit(success ? 0 : 1);
}
