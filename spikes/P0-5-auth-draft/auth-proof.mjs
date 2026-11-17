/**
 * P0-5 Auth & Teams Runnable Proof
 *
 * Verifies Neo Gateway Auth & RBAC contracts using Node 22 native SQLite:
 * 1. User registration & secure password hashing (scrypt)
 * 2. Session authentication & token hashing (SHA-256)
 * 3. Workspace creation (Owner role)
 * 4. Member invitation with Viewer role
 * 5. Role-based Access Control: Viewer write denied (403 Forbidden), read allowed
 * 6. Owner write permitted
 * 7. Scoped API token issuance, execution, and revocation
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// Database Setup & Schema
// -----------------------------------------------------------------------------
export function createAuthDatabase(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);

  // Enable foreign keys
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
      created_at INTEGER NOT NULL,
      UNIQUE(workspace_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member', 'viewer')),
      revoked_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_resources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
  `);

  return db;
}

// -----------------------------------------------------------------------------
// Security Utilities (Scrypt & SHA-256)
// -----------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, storedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// -----------------------------------------------------------------------------
// Auth & Workspace Service API
// -----------------------------------------------------------------------------
export class AuthService {
  constructor(db) {
    this.db = db;
  }

  signup(email, password) {
    const id = `usr_${crypto.randomBytes(8).toString('hex')}`;
    const { salt, hash } = hashPassword(password);
    const now = Date.now();

    const stmt = this.db.prepare(
      'INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(id, email.toLowerCase(), hash, salt, now);
    return { userId: id, email: email.toLowerCase() };
  }

  login(email, password) {
    const stmt = this.db.prepare('SELECT id, password_hash, salt FROM users WHERE email = ?');
    const user = stmt.get(email.toLowerCase());
    if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
      throw new Error('Invalid email or password');
    }

    const sessionId = `ses_${crypto.randomBytes(8).toString('hex')}`;
    const rawToken = `neo_sess_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = hashToken(rawToken);
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

    this.db.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(sessionId, user.id, tokenHash, expiresAt, now);

    return { sessionId, sessionToken: rawToken, userId: user.id };
  }

  createWorkspace(sessionToken, name) {
    const auth = this.authenticate(sessionToken);
    const workspaceId = `ws_${crypto.randomBytes(8).toString('hex')}`;
    const memberId = `mem_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();

    this.db.prepare(
      'INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(workspaceId, name, auth.userId, now);

    this.db.prepare(
      'INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(memberId, workspaceId, auth.userId, 'owner', now);

    return { workspaceId, name, ownerId: auth.userId };
  }

  inviteMember(sessionToken, workspaceId, targetEmail, role) {
    const auth = this.authenticate(sessionToken);
    const callerMember = this.getMember(workspaceId, auth.userId);

    if (!callerMember || !['owner', 'admin'].includes(callerMember.role)) {
      const err = new Error('Forbidden: only owner or admin can invite members');
      err.statusCode = 403;
      throw err;
    }

    const targetUser = this.db.prepare('SELECT id FROM users WHERE email = ?').get(targetEmail.toLowerCase());
    if (!targetUser) {
      throw new Error(`User with email ${targetEmail} does not exist`);
    }

    const memberId = `mem_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();

    this.db.prepare(
      'INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(memberId, workspaceId, targetUser.id, role, now);

    return { memberId, workspaceId, userId: targetUser.id, role };
  }

  issueApiToken(sessionToken, workspaceId, tokenName, role = 'member') {
    const auth = this.authenticate(sessionToken);
    const callerMember = this.getMember(workspaceId, auth.userId);

    if (!callerMember || !['owner', 'admin'].includes(callerMember.role)) {
      const err = new Error('Forbidden: only owner or admin can issue API tokens');
      err.statusCode = 403;
      throw err;
    }

    const tokenId = `tok_${crypto.randomBytes(8).toString('hex')}`;
    const rawToken = `neo_pat_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = hashToken(rawToken);
    const now = Date.now();

    this.db.prepare(
      'INSERT INTO api_tokens (id, workspace_id, user_id, name, token_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(tokenId, workspaceId, auth.userId, tokenName, tokenHash, role, now);

    return { tokenId, apiToken: rawToken, name: tokenName, role };
  }

  revokeApiToken(sessionToken, workspaceId, tokenId) {
    const auth = this.authenticate(sessionToken);
    const callerMember = this.getMember(workspaceId, auth.userId);

    if (!callerMember || !['owner', 'admin'].includes(callerMember.role)) {
      const err = new Error('Forbidden: only owner or admin can revoke API tokens');
      err.statusCode = 403;
      throw err;
    }

    this.db.prepare(
      'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ?'
    ).run(Date.now(), tokenId, workspaceId);

    return { revoked: true, tokenId };
  }

  // Unified Request Authenticator (supports session token or API token)
  authenticate(tokenString) {
    if (!tokenString) {
      const err = new Error('Unauthorized: missing token');
      err.statusCode = 401;
      throw err;
    }

    const cleanToken = tokenString.replace(/^Bearer\s+/i, '').trim();
    const tokenHash = hashToken(cleanToken);
    const now = Date.now();

    if (cleanToken.startsWith('neo_pat_')) {
      // API Token
      const row = this.db.prepare(`
        SELECT t.id, t.workspace_id, t.user_id, t.role, t.revoked_at
        FROM api_tokens t
        WHERE t.token_hash = ?
      `).get(tokenHash);

      if (!row) {
        const err = new Error('Unauthorized: invalid API token');
        err.statusCode = 401;
        throw err;
      }
      if (row.revoked_at !== null) {
        const err = new Error('Unauthorized: API token has been revoked');
        err.statusCode = 401;
        throw err;
      }

      return { type: 'api_token', tokenId: row.id, userId: row.user_id, workspaceId: row.workspace_id, role: row.role };
    }

    // Session Token
    const row = this.db.prepare(`
      SELECT s.id, s.user_id, s.expires_at
      FROM sessions s
      WHERE s.token_hash = ?
    `).get(tokenHash);

    if (!row) {
      const err = new Error('Unauthorized: invalid session token');
      err.statusCode = 401;
      throw err;
    }
    if (row.expires_at < now) {
      const err = new Error('Unauthorized: session expired');
      err.statusCode = 401;
      throw err;
    }

    return { type: 'session', sessionId: row.id, userId: row.user_id };
  }

  getMember(workspaceId, userId) {
    return this.db.prepare(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).get(workspaceId, userId);
  }

  // Scoped Resource Access
  writeResource(token, workspaceId, resourceType, resourceName, payload) {
    const auth = this.authenticate(token);
    let effectiveRole = null;

    if (auth.type === 'api_token') {
      if (auth.workspaceId !== workspaceId) {
        const err = new Error('Forbidden: API token not scoped to this workspace');
        err.statusCode = 403;
        throw err;
      }
      effectiveRole = auth.role;
    } else {
      const member = this.getMember(workspaceId, auth.userId);
      if (!member) {
        const err = new Error('Forbidden: user not a member of this workspace');
        err.statusCode = 403;
        throw err;
      }
      effectiveRole = member.role;
    }

    // Role check: viewers cannot write
    if (effectiveRole === 'viewer') {
      const err = new Error('Forbidden: viewer role cannot perform write operations');
      err.statusCode = 403;
      throw err;
    }

    const resId = `res_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO workspace_resources (id, workspace_id, type, name, payload, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(resId, workspaceId, resourceType, resourceName, JSON.stringify(payload), auth.userId, now);

    return { status: 201, resourceId: resId, name: resourceName, role: effectiveRole };
  }

  readResource(token, workspaceId, resourceId) {
    const auth = this.authenticate(token);
    let effectiveRole = null;

    if (auth.type === 'api_token') {
      if (auth.workspaceId !== workspaceId) {
        const err = new Error('Forbidden: API token not scoped to this workspace');
        err.statusCode = 403;
        throw err;
      }
      effectiveRole = auth.role;
    } else {
      const member = this.getMember(workspaceId, auth.userId);
      if (!member) {
        const err = new Error('Forbidden: user not a member of this workspace');
        err.statusCode = 403;
        throw err;
      }
      effectiveRole = member.role;
    }

    const row = this.db.prepare(
      'SELECT id, type, name, payload, created_by FROM workspace_resources WHERE id = ? AND workspace_id = ?'
    ).get(resourceId, workspaceId);

    if (!row) {
      const err = new Error('Resource not found');
      err.statusCode = 404;
      throw err;
    }

    return { status: 200, resource: row, role: effectiveRole };
  }
}

// -----------------------------------------------------------------------------
// Test Runner
// -----------------------------------------------------------------------------
export function runAuthProof(options = {}) {
  const dbPath = options.dbPath || ':memory:';
  const db = createAuthDatabase(dbPath);
  const auth = new AuthService(db);
  const results = [];

  function record(check, passed, detail) {
    results.push({ check, passed, detail });
    const mark = passed ? '[PASS]' : '[FAIL]';
    console.log(`${mark} ${check}: ${detail}`);
  }

  try {
    // 1. Sign up local accounts
    const owner = auth.signup('alice.owner@neo.local', 'MasterPassword!123');
    const viewer = auth.signup('bob.viewer@neo.local', 'ViewerPass#456');
    record('signup', Boolean(owner.userId && viewer.userId), `Created owner (${owner.email}) and viewer (${viewer.email}) local accounts`);

    // 2. Log in and issue session tokens
    const ownerSession = auth.login('alice.owner@neo.local', 'MasterPassword!123');
    const viewerSession = auth.login('bob.viewer@neo.local', 'ViewerPass#456');
    record('login', Boolean(ownerSession.sessionToken && viewerSession.sessionToken), 'Authenticated credentials and issued session tokens');

    // 3. Create workspace
    const ws = auth.createWorkspace(ownerSession.sessionToken, 'Neo Core Team');
    record('workspace_create', ws.workspaceId.startsWith('ws_'), `Created workspace '${ws.name}' (${ws.workspaceId})`);

    // 4. Invite member with 'viewer' role
    const invite = auth.inviteMember(ownerSession.sessionToken, ws.workspaceId, viewer.email, 'viewer');
    record('invite_member', invite.role === 'viewer', `Added ${viewer.email} as workspace member with role 'viewer'`);

    // 5. Viewer attempts write operation -> Must receive 403 Forbidden
    let viewerWriteBlocked = false;
    try {
      auth.writeResource(
        viewerSession.sessionToken,
        ws.workspaceId,
        'bot',
        'Unauthorized Bot',
        { prompt: 'Malicious turn' }
      );
    } catch (err) {
      if (err.statusCode === 403) {
        viewerWriteBlocked = true;
      }
    }
    record('viewer_write_denied', viewerWriteBlocked, 'Write operation by viewer rejected with 403 Forbidden');

    // 6. Owner performs write operation -> Permitted
    const resource = auth.writeResource(
      ownerSession.sessionToken,
      ws.workspaceId,
      'bot',
      'Hermes SuperAgent Profile',
      { model: 'claude-3-7-sonnet', skills: ['terminal', 'browser'] }
    );
    record('owner_write_permitted', resource.status === 201, `Owner created resource '${resource.name}' (${resource.resourceId})`);

    // 7. Viewer reads resource -> Permitted (200 OK)
    const readRes = auth.readResource(viewerSession.sessionToken, ws.workspaceId, resource.resourceId);
    record('viewer_read_allowed', readRes.status === 200, `Viewer successfully read resource '${readRes.resource.name}'`);

    // 8. Issue scoped API token for automated CI
    const apiToken = auth.issueApiToken(ownerSession.sessionToken, ws.workspaceId, 'ci-deployer-token', 'member');
    record('api_token_issue', apiToken.apiToken.startsWith('neo_pat_'), `Issued API token '${apiToken.name}' with role 'member'`);

    // 9. API token performs write -> Permitted
    const tokenResource = auth.writeResource(
      apiToken.apiToken,
      ws.workspaceId,
      'project',
      'CI Automated Project',
      { repo: 'neo-meta-harness' }
    );
    record('api_token_write_permitted', tokenResource.status === 201, `API token created resource '${tokenResource.name}'`);

    // 10. Revoke API token
    auth.revokeApiToken(ownerSession.sessionToken, ws.workspaceId, apiToken.tokenId);

    // 11. Request using revoked API token -> Must receive 401 Unauthorized
    let revokedTokenBlocked = false;
    try {
      auth.writeResource(
        apiToken.apiToken,
        ws.workspaceId,
        'project',
        'Forbidden Project',
        {}
      );
    } catch (err) {
      if (err.statusCode === 401) {
        revokedTokenBlocked = true;
      }
    }
    record('api_token_revoked_blocked', revokedTokenBlocked, 'Request using revoked API token rejected with 401 Unauthorized');

  } finally {
    db.close();
  }

  const allPassed = results.every(r => r.passed);
  console.log(`\nFinal Result: ${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n`);
  return allPassed;
}

// Direct Execution
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const success = runAuthProof();
  process.exit(success ? 0 : 1);
}
