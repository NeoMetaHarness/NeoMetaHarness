import assert from 'node:assert/strict';
import test from 'node:test';
import type { LookupAddress } from 'node:dns';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublicEgressAddress, createEgressFetch, DEFAULT_EGRESS_MAX_RESPONSE_BYTES, guardedEgressLookup,
  validateEgressUrl } from '../src/index.js';

test('URL validation: https only, no credentials, no private hosts unless allowed', () => {
  assert.equal(validateEgressUrl('https://api.x.ai/v1').hostname, 'api.x.ai');
  for (const bad of ['http://api.x.ai', 'https://user:pw@api.x.ai', 'https://api.x.ai/#frag', 'ftp://api.x.ai']) {
    assert.throws(() => validateEgressUrl(bad), /HTTPS URL without credentials/, bad);
  }
  for (const bad of ['https://localhost', 'https://a.localhost', 'https://printer.local', 'https://svc.internal', 'https://intranet',
    'https://10.0.0.5', 'https://169.254.169.254', 'https://127.0.0.1', 'https://[::1]', 'https://[fd00::1]', 'https://[fe80::1]',
    'https://[::ffff:127.0.0.1]', 'https://100.64.0.1', 'https://192.168.1.1']) {
    assert.throws(() => validateEgressUrl(bad), /denied/, bad);
  }
  assert.equal(validateEgressUrl('https://10.0.0.5', true).hostname, '10.0.0.5');
  assert.throws(() => validateEgressUrl('http://10.0.0.5', true), /HTTPS/, 'private network still requires https');
});

test('address checks cover IPv4, IPv6 and mapped forms', () => {
  for (const ok of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.doesNotThrow(() => assertPublicEgressAddress(ok), ok);
  for (const bad of ['0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1',
    '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1', '2001:db8::1', 'not-an-ip']) {
    assert.throws(() => assertPublicEgressAddress(bad), /denied/, bad);
  }
});

function fakeResolver(addresses: LookupAddress[]) {
  return ((_host: string, _opts: unknown, cb: (e: Error | null, a: LookupAddress[]) => void) => cb(null, addresses)) as never;
}
function runLookup(allowPrivate: boolean, addresses: LookupAddress[]) {
  return new Promise<string>((resolve, reject) => guardedEgressLookup(allowPrivate, fakeResolver(addresses))('evil.example', {},
    (error, address) => (error ? reject(error) : resolve(String(address)))));
}

test('DNS rebinding: the address checked is the address connected to, and any private answer denies', async () => {
  assert.equal(await runLookup(false, [{ address: '8.8.8.8', family: 4 }]), '8.8.8.8');
  await assert.rejects(runLookup(false, [{ address: '10.0.0.5', family: 4 }]), /denied/);
  await assert.rejects(runLookup(false, [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]), /denied/);
  await assert.rejects(runLookup(false, []), /no addresses/);
  assert.equal(await runLookup(true, [{ address: '10.0.0.5', family: 4 }]), '10.0.0.5');
});

test('fetch wrapper: validates before sending, refuses redirects, applies a default timeout, ignores non-boolean flags', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const injected = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status }); }) as typeof fetch;

  const ok = createEgressFetch(() => false, injected, 1234);
  assert.equal((await ok('https://api.x.ai/v1/search', { method: 'POST' })).status, 200);
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.ok(calls[0]!.init.signal instanceof AbortSignal, 'default timeout signal applied');

  await assert.rejects(ok('http://api.x.ai/v1'), /HTTPS/);
  await assert.rejects(ok('https://169.254.169.254/latest/meta-data'), /denied/);
  assert.equal(calls.length, 1, 'rejected URLs never reach the client');

  status = 302;
  await assert.rejects(ok('https://api.x.ai/v1'), /redirect denied/);

  const stringFlag = createEgressFetch(() => 'false' as unknown as boolean, injected);
  await assert.rejects(stringFlag('https://10.0.0.5/'), /denied/, 'the string "false" must not open private egress');
});

// A client that never answers until its signal aborts, then rejects with the abort reason.
// AbortSignal.timeout() timers are unref'd, so the fake keeps the event loop alive while it waits (a real
// Gateway's server does that in production).
const hanging = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
  const signal = init.signal!;
  if (signal.aborted) { reject(signal.reason); return; }
  const alive = setInterval(() => {}, 1_000);
  signal.addEventListener('abort', () => { clearInterval(alive); reject(signal.reason); }, { once: true });
})) as typeof fetch;

test('timeout: still applies when the caller passes its own signal; the caller can still abort', async () => {
  const guarded = createEgressFetch(() => false, hanging, { timeoutMs: 50 });
  const caller = new AbortController(); // never aborted
  const started = Date.now();
  await assert.rejects(guarded('https://api.x.ai/v1', { signal: caller.signal }), (error: Error) => error.name === 'TimeoutError',
    'a caller signal no longer replaces the timeout');
  assert.ok(Date.now() - started < 5_000, 'timed out promptly');
  // The caller's own signal still aborts first when it fires before the timeout.
  const slow = createEgressFetch(() => false, hanging, { timeoutMs: 60_000 });
  const early = new AbortController();
  setTimeout(() => early.abort(new Error('caller aborted')), 20);
  await assert.rejects(slow('https://api.x.ai/v1', { signal: early.signal }), /caller aborted/);
  // Without a caller signal the timeout applies as before; the number form of the third argument still works.
  await assert.rejects(createEgressFetch(() => false, hanging, 50)('https://api.x.ai/v1'), (error: Error) => error.name === 'TimeoutError');
  assert.throws(() => createEgressFetch(() => false, hanging, { timeoutMs: 0 }), /positive/);
});

test('maxResponseBytes: default 1 MB, raisable, never disabled', async () => {
  let body = 'x'.repeat(DEFAULT_EGRESS_MAX_RESPONSE_BYTES + 1);
  let withLength = false;
  const client = (async () => new Response(body, withLength ? { headers: { 'content-length': String(body.length) } } : {})) as typeof fetch;
  assert.equal(DEFAULT_EGRESS_MAX_RESPONSE_BYTES, 1_000_000);
  await assert.rejects(createEgressFetch(() => false, client)('https://api.x.ai/v1'), /too large/, 'the default cap applies');
  const raised = createEgressFetch(() => false, client, { maxResponseBytes: 5_000_000 });
  assert.equal((await (await raised('https://api.x.ai/v1')).text()).length, body.length, 'a raised cap admits bigger bodies');
  body = 'x'.repeat(5_000_001);
  await assert.rejects(raised('https://api.x.ai/v1'), /too large/, 'the raised cap is still a cap');
  withLength = true;
  await assert.rejects(raised('https://api.x.ai/v1'), /too large/, 'a declared content-length over the cap fails early');
  body = 'small';
  const ok = await raised('https://api.x.ai/v1');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'small');
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createEgressFetch(() => false, client, { maxResponseBytes: bad }), /positive/, String(bad));
  }
});

test('built-in HTTPS client: the same timeout and size cap apply', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nmh-egress-tls-'));
  try {
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    } catch {
      t.skip('openssl is not available to make a throwaway certificate');
      return;
    }
    const server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (req, res) => {
      if (req.url === '/hang') return; // never answers
      const size = Number(new URL(req.url!, 'https://127.0.0.1').searchParams.get('size'));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(size, 1));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    // Self-signed throwaway certificate: verification is off only for this local test server.
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const base = `https://127.0.0.1:${port}`;
      const standard = createEgressFetch(() => true, undefined, { timeoutMs: 300 });
      assert.equal((await (await standard(`${base}/?size=1000`)).arrayBuffer()).byteLength, 1000);
      await assert.rejects(standard(`${base}/?size=1500000`), /too large/, 'default 1 MB cap');
      const screenshots = createEgressFetch(() => true, undefined, { timeoutMs: 300, maxResponseBytes: 4_000_000 });
      assert.equal((await (await screenshots(`${base}/?size=1500000`)).arrayBuffer()).byteLength, 1_500_000);
      await assert.rejects(screenshots(`${base}/?size=4000001`), /too large/);
      const caller = new AbortController();
      await assert.rejects(standard(`${base}/hang`, { signal: caller.signal }), (error: Error) => error.name === 'TimeoutError' || /abort/i.test(error.message),
        'a caller signal does not remove the timeout on the built-in client');
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
