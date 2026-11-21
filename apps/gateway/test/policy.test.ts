import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { neoContract } from '@neometaharness/contracts';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { startGateway } from '../src/server.js';
import {
  ROUTE_POLICY,
  CONTRACT_POLICY,
  HTTP_ROUTE_POLICY,
  getPolicy,
  authorize,
  getContractProcedurePaths,
  type PolicyLevel,
} from '../src/policy.js';

type GatewayClient = ContractRouterClient<typeof neoContract>;

function makeClient(port: number, headers: Record<string, string> = {}): GatewayClient {
  return createORPCClient<GatewayClient>(
    new RPCLink({
      url: `http://127.0.0.1:${port}`,
      headers: () => headers,
    })
  );
}

function verifyContractCoverage(contract: any, policy: Record<string, PolicyLevel>) {
  const contractPaths = getContractProcedurePaths(contract).sort();
  const policyPaths = Object.keys(policy).sort();

  const missingFromPolicy = contractPaths.filter((p) => !(p in policy));
  const danglingInPolicy = policyPaths.filter((p) => !contractPaths.includes(p));

  if (missingFromPolicy.length > 0 || danglingInPolicy.length > 0) {
    throw new Error(
      `Route policy mapping mismatch!\nMissing from policy: ${JSON.stringify(missingFromPolicy)}\nDangling in policy: ${JSON.stringify(danglingInPolicy)}`
    );
  }
}

async function callHandler(handler: any, input: any, context: any) {
  const res = handler({ input, context });
  if (res && typeof res.next === 'function') {
    return await res.next();
  }
  return await res;
}

test('Contract coverage: 1:1 bi-directional mapping between neoContract and policy table', () => {
  const contractPaths = getContractProcedurePaths(neoContract).sort();
  const contractPolicyPaths = Object.keys(CONTRACT_POLICY).sort();

  // 1. Bi-directional exact match
  assert.equal(
    contractPolicyPaths.length,
    contractPaths.length,
    `Contract policy entries count (${contractPolicyPaths.length}) must match neoContract leaf procedures count (${contractPaths.length})`
  );
  assert.deepEqual(
    contractPolicyPaths,
    contractPaths,
    'CONTRACT_POLICY must have exact 1:1 mapping with all procedure paths in neoContract'
  );

  // 2. Verify all contract procedures have a policy entry in ROUTE_POLICY
  for (const path of contractPaths) {
    const level = ROUTE_POLICY[path];
    assert.ok(
      level === 'viewer' || level === 'member' || level === 'admin' || level === 'owner' || level === 'deployment-owner' || level === 'internal',
      `Route ${path} must have a valid PolicyLevel in ROUTE_POLICY, found: ${level}`
    );
  }

  // 3. Verify no dangling entries in CONTRACT_POLICY
  for (const policyKey of Object.keys(CONTRACT_POLICY)) {
    assert.ok(
      contractPaths.includes(policyKey),
      `CONTRACT_POLICY contains dangling procedure key not in neoContract: ${policyKey}`
    );
  }

  // 4. Verify HTTP_ROUTE_POLICY entries and coverage in ROUTE_POLICY
  const expectedHttpRoutes = [
    '/internal/memory/context',
    '/internal/memory/write',
    '/internal/computers/action',
    '/auth/ws-ticket',
    '/auth/*',
    '/x/*',
  ];
  for (const route of expectedHttpRoutes) {
    assert.ok(route in HTTP_ROUTE_POLICY, `HTTP_ROUTE_POLICY must contain ${route}`);
    assert.equal(ROUTE_POLICY[route], HTTP_ROUTE_POLICY[route], `ROUTE_POLICY must document ${route}`);
  }

  // 5. Negative tests: adding an unmapped procedure breaks contract coverage
  const syntheticMissing = { ...neoContract, unmappedModule: { newRoute: neoContract.extensions.list } };
  assert.throws(
    () => verifyContractCoverage(syntheticMissing, CONTRACT_POLICY),
    /Missing from policy/,
    'Adding a contract route without a policy entry must fail coverage verification'
  );

  // 6. Negative test: adding a dangling policy entry breaks contract coverage
  const syntheticDangling = { ...CONTRACT_POLICY, 'unmapped.dangling.procedure': 'member' as const };
  assert.throws(
    () => verifyContractCoverage(neoContract, syntheticDangling),
    /Dangling in policy/,
    'Adding a dangling policy entry without a contract route must fail coverage verification'
  );
});

test('Behaviour test across all contract procedures: 401 for unauth, 403 for non-member, 403 for viewer when policy > viewer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-policy-test-'));
  const databaseFile = join(root, 'gateway.db');
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir);

  const gateway = await startGateway({
    databaseFile,
    mode: 'server',
    signup: 'open', // these suites predate SEC-08 and register users freely
  });

  try {
    const contractPaths = getContractProcedurePaths(neoContract);
    assert.ok(contractPaths.length >= 76, `Expected at least 76 procedures in neoContract, got ${contractPaths.length}`);

    const outsiderContext = {
      user: { id: 'usr-outsider-999', email: 'outsider@neo.local', name: 'Outsider' },
      session: { id: 'ses-outsider-999' },
      role: undefined,
      workspaceId: undefined,
    };

    const viewerContext = {
      user: { id: 'usr-viewer-123', email: 'viewer@neo.local', name: 'Viewer' },
      session: { id: 'ses-viewer-123' },
      role: 'viewer' as const,
      workspaceId: 'ws-main',
    };

    for (const path of contractPaths) {
      const level = getPolicy(path);
      assert.ok(level, `Policy level must exist for ${path}`);

      // Locate the handler in gateway.router
      const parts = path.split('.');
      let proc: any = gateway.router;
      for (const part of parts) {
        proc = proc?.[part];
      }
      const handler = typeof proc === 'function' ? proc : proc?.['~orpc']?.handler;
      assert.equal(
        typeof handler,
        'function',
        `Procedure handler for ${path} must exist in gateway.router`
      );

      // 1. Unauthenticated caller -> 401 UNAUTHORIZED
      await assert.rejects(
        callHandler(handler, undefined, undefined),
        (err: any) => err.code === 'UNAUTHORIZED',
        `Unauthenticated call to ${path} must throw UNAUTHORIZED (401)`
      );

      await assert.rejects(
        callHandler(handler, undefined, { user: undefined }),
        (err: any) => err.code === 'UNAUTHORIZED',
        `Unauthenticated call with empty user to ${path} must throw UNAUTHORIZED (401)`
      );

      // 2. Non-member (outsider) session -> 403 FORBIDDEN
      await assert.rejects(
        callHandler(handler, undefined, outsiderContext),
        (err: any) => err.code === 'FORBIDDEN',
        `Non-member session call to ${path} must throw FORBIDDEN (403)`
      );

      // 3. Viewer session -> 403 FORBIDDEN if policy > viewer
      if (level !== 'viewer') {
        await assert.rejects(
          callHandler(handler, undefined, viewerContext),
          (err: any) => err.code === 'FORBIDDEN',
          `Viewer session call to ${path} (level=${level}) must throw FORBIDDEN (403)`
        );
      } else {
        // If policy is viewer, authorize must pass and NOT reject with UNAUTHORIZED or FORBIDDEN
        try {
          await callHandler(handler, undefined, viewerContext);
        } catch (err: any) {
          assert.notEqual(
            err.code,
            'UNAUTHORIZED',
            `Viewer call to ${path} should pass authentication, got UNAUTHORIZED`
          );
          assert.notEqual(
            err.code,
            'FORBIDDEN',
            `Viewer call to ${path} should be permitted by policy, got FORBIDDEN`
          );
        }
      }
    }
  } finally {
    await gateway.close();
  }
});

test('HTTP/oRPC integration: Auth runs before engine calls (disabled extension returns 401/403, never 404), and plain HTTP routes covered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nmh-policy-http-'));
  const databaseFile = join(root, 'gateway.db');
  const extensionsDir = join(root, 'extensions');
  await mkdir(extensionsDir);

  for (const [id, route, result] of [
    ['test-custom', 'status', { ok: true, version: '1.0' }],
    ['memory-local', 'list', {}],
  ] as const) {
    const directory = join(extensionsDir, id);
    await mkdir(directory);
    await writeFile(join(directory, 'neo.extension.json'), JSON.stringify({
      id, version: '1.0.0', displayName: id, runtime: { type: 'cordis', entry: './index.mjs' },
    }));
    await writeFile(join(directory, 'index.mjs'), `export default { activate(ctx) { ctx.route(${JSON.stringify(route)}, () => (${JSON.stringify(result)})); } };`);
  }
  const gateway = await startGateway({
    databaseFile,
    extensionsDir,
    mode: 'server',
    signup: 'open', // these suites predate SEC-08 and register users freely
  });

  const base = `http://127.0.0.1:${gateway.port}`;

  try {
    // 1. Setup accounts: owner, viewer, outsider
    const ownerRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@neo.local', password: 'OwnerPassword!123', name: 'Owner' }),
    });
    const ownerUser = await ownerRes.json();
    const ownerLogin = await (await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@neo.local', password: 'OwnerPassword!123' }),
    })).json();
    const ownerToken = ownerLogin.token;

    const orgRes = await fetch(`${base}/auth/organization/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: 'Policy Workspace', slug: 'policy-ws' }),
    });
    const workspace = await orgRes.json();

    const viewerRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@neo.local', password: 'ViewerPassword!123', name: 'Viewer' }),
    });
    const viewerUser = await viewerRes.json();
    const viewerLogin = await (await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'viewer@neo.local', password: 'ViewerPassword!123' }),
    })).json();
    const viewerToken = viewerLogin.token;

    await gateway.auth.api.addMember({
      body: { organizationId: workspace.id, userId: viewerUser.user.id, role: 'viewer' },
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });

    const outsiderRes = await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'outsider@neo.local', password: 'OutsiderPassword!123', name: 'Outsider' }),
    });
    const outsiderLogin = await (await fetch(`${base}/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'outsider@neo.local', password: 'OutsiderPassword!123' }),
    })).json();
    const outsiderToken = outsiderLogin.token;

    const unauthClient = makeClient(gateway.port);
    const outsiderClient = makeClient(gateway.port, { authorization: `Bearer ${outsiderToken}` });
    const viewerClient = makeClient(gateway.port, { authorization: `Bearer ${viewerToken}` });
    const upgrade = { id: 'test-custom', directory: join(root, 'candidate'), integrity: '0'.repeat(64) };
    await assert.rejects(viewerClient.extensions.upgrade(upgrade), (error: any) => error.code === 'FORBIDDEN');
    const adminSignup = await (await fetch(`${base}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'upgrade-admin@neo.local', password: 'AdminPassword!123', name: 'Admin' }),
    })).json();
    await gateway.auth.api.addMember({
      body: { organizationId: workspace.id, userId: adminSignup.user.id, role: 'admin' },
      headers: new Headers({ authorization: `Bearer ${ownerToken}` }),
    });
    const adminClient = makeClient(gateway.port, { authorization: `Bearer ${adminSignup.token}` });
    assert.equal((await adminClient.extensions.enable({ id: 'test-custom' })).status, 'running');
    await assert.rejects(adminClient.extensions.upgrade(upgrade), (error: any) => error.code === 'FORBIDDEN');
    assert.equal((await adminClient.extensions.disable({ id: 'test-custom' })).status, 'disabled');
    await assert.rejects(adminClient.extensions.uninstall({ id: 'test-custom' }), (error: any) => error.code === 'FORBIDDEN');

    // 2. Disabled extension check:
    // Extensions (engine-t3, engine-hermes, engine-superagent, skills-registry) are NOT running in this test environment.
    // Calling x.engine-t3.send, agents.bots.create, or inbox.ask must fail with 401 or 403, NEVER 404 / 503!

    // Unauthenticated caller -> 401 (not 404/503)
    await assert.rejects(
      unauthClient.x['engine-t3'].send({ threadId: 't-1', text: 'hello' }),
      (err: any) => err.code === 'UNAUTHORIZED',
      'Unauthenticated call to disabled extension route must fail with 401, not 404'
    );
    await assert.rejects(
      unauthClient.inbox.ask({ botId: 'b-1', text: 'question' }),
      (err: any) => err.code === 'UNAUTHORIZED',
      'Unauthenticated call to disabled inbox route must fail with 401, not 503'
    );
    await assert.rejects(
      unauthClient.x['skills-registry'].list(),
      (err: any) => err.code === 'UNAUTHORIZED',
      'Unauthenticated call to disabled skills-registry route must fail with 401, not 404'
    );

    // Outsider (non-member) caller -> 403 (not 404/503)
    await assert.rejects(
      outsiderClient.x['engine-t3'].send({ threadId: 't-1', text: 'hello' }),
      (err: any) => err.code === 'FORBIDDEN',
      'Non-member call to disabled extension route must fail with 403, not 404'
    );
    await assert.rejects(
      outsiderClient.inbox.ask({ botId: 'b-1', text: 'question' }),
      (err: any) => err.code === 'FORBIDDEN',
      'Non-member call to disabled inbox route must fail with 403, not 503'
    );
    await assert.rejects(
      outsiderClient.x['skills-registry'].list(),
      (err: any) => err.code === 'FORBIDDEN',
      'Non-member call to disabled skills-registry route must fail with 403, not 404'
    );

    // Viewer caller on member route -> 403 (not 404/503)
    await assert.rejects(
      viewerClient.x['engine-t3'].send({ threadId: 't-1', text: 'hello' }),
      (err: any) => err.code === 'FORBIDDEN',
      'Viewer call to member route must fail with 403, not 404'
    );
    await assert.rejects(
      viewerClient.inbox.ask({ botId: 'b-1', text: 'question' }),
      (err: any) => err.code === 'SERVICE_UNAVAILABLE',
      'Viewer observe asks may pass authorization, then fail if the superagent is disabled'
    );
    await assert.rejects(
      viewerClient.agents.bots.create({ name: 'New Bot' }),
      (err: any) => err.code === 'FORBIDDEN',
      'Viewer call to agents.bots.create must fail with 403, not 503'
    );
    await assert.rejects(
      viewerClient.x['skills-registry'].import({
        name: 'test-skill',
        content: 'prompt',
        sourceProfile: 'default',
        sourcePath: '/path',
      }),
      (err: any) => err.code === 'FORBIDDEN',
      'Viewer call to skills-registry import must fail with 403, not 404'
    );

    // 3. Plain HTTP extension routes (kernel.hasRoute GET path)
    await gateway.kernel.enable('test-custom');

    // Unauthenticated GET -> 401
    const unauthGet = await fetch(`${base}/x/test-custom/status`);
    assert.equal(unauthGet.status, 401, 'Unauthenticated GET to /x/ route must return 401');

    // Outsider GET -> 403
    const outsiderGet = await fetch(`${base}/x/test-custom/status`, {
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    assert.equal(outsiderGet.status, 403, 'Outsider GET to /x/ route must return 403');

    // Viewer GET -> 200
    const viewerGet = await fetch(`${base}/x/test-custom/status`, {
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(viewerGet.status, 200, 'Viewer GET to /x/ route must succeed with 200');
    const data = await viewerGet.json();
    assert.equal(data.ok, true);

    // POST on GET route -> 405
    const viewerPost = await fetch(`${base}/x/test-custom/status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(viewerPost.status, 405, 'POST to GET route must return 405');

    // Unregistered /x/ route -> 404
    const unmappedGet = await fetch(`${base}/x/nonexistent/endpoint`, {
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(unmappedGet.status, 404, 'Unregistered /x/ route must return 404');

    // 4. Internal HTTP routes
    await gateway.kernel.enable('memory-local');
    const internalMemGet = await fetch(`${base}/internal/memory/context?profile=default`);
    assert.equal(internalMemGet.status, 401, 'Internal memory context without bearer token must return 401');

    const internalCompPost = await fetch(`${base}/internal/computers/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'state' }),
    });
    assert.equal(internalCompPost.status, 401, 'Internal computers action without token must return 401');

    const wsTicketUnauth = await fetch(`${base}/auth/ws-ticket`, { method: 'POST' });
    assert.equal(wsTicketUnauth.status, 401, 'ws-ticket without auth must return 401');

    const wsTicketViewer = await fetch(`${base}/auth/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(wsTicketViewer.status, 200, 'ws-ticket with viewer auth must return 200');
    const ticketData = await wsTicketViewer.json();
    assert.ok(ticketData.ticket, 'ws-ticket must return ticket');
  } finally {
    await gateway.close();
  }
});
