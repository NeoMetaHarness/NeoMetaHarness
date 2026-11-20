import assert from 'node:assert/strict';
import test from 'node:test';
import type { LookupAddress } from 'node:dns';
import { assertPublicEgressAddress, createEgressFetch, guardedEgressLookup, validateEgressUrl } from '../src/index.js';

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
