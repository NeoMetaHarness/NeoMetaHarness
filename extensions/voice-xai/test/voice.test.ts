import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { neoContract } from '@neometaharness/contracts';
import type { ContractRouterClient } from '@orpc/contract';
import { XaiVoiceService, type VoiceHttpClient } from '../src/index.js';
import { validateEgressUrl } from '@neometaharness/egress';
import { startGateway as createGateway } from '../../../apps/gateway/src/server.js';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
type Client = ContractRouterClient<typeof neoContract>;
const key = 'FAKE_XAI_KEY_OFFLINE_TEST_78341';
const audio = Buffer.from('FAKE_MP3_BYTES');

async function startFake() {
  const hits: string[] = [];
  const pendingAborts = new Map<string, { started: () => void; closed: () => void }>();
  const watchAbort = (kind: string) => {
    let started!: () => void;
    let closed!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const closedPromise = new Promise<void>(resolve => { closed = resolve; });
    pendingAborts.set(kind, { started, closed });
    return { started: startedPromise, closed: closedPromise };
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    if (body.includes('ABORT_GATEWAY_TEST')) {
      const kind = req.url === '/v1/stt' ? 'stt' : 'tts';
      const pending = pendingAborts.get(kind);
      if (!pending) throw new Error('Unexpected pending voice request');
      res.once('close', pending.closed);
      pending.started();
      return;
    }
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end('No credential');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/stt') {
      assert.match(req.headers['content-type'] || '', /multipart\/form-data; boundary=/);
      assert.match(body, /grok-voice-transcribe-2\.0/);
      assert.match(body, /audio\.mp3/);
      assert.match(body, /FAKE_MP3_BYTES/);
      hits.push('stt');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'Fake transcript', language: 'en', duration: 1.5 }));
    } else if (req.method === 'POST' && req.url === '/v1/tts') {
      assert.deepEqual(JSON.parse(body), { text: 'Hi there', voice_id: 'ara', language: 'hi' });
      hits.push('tts');
      res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(audio);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, hits, watchAbort };
}

async function assertNativeMultipartStt(home: string): Promise<void> {
  const certDir = join(home, 'native-https');
  await mkdir(certDir);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
  let nativeHits = 0;
  const server = createHttpsServer({
    key: await readFile(join(certDir, 'key.pem')),
    cert: await readFile(join(certDir, 'cert.pem')),
  }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    assert.equal(req.url, '/v1/stt');
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    assert.match(req.headers['content-type'] || '', /multipart\/form-data; boundary=/);
    assert.match(body, /grok-voice-transcribe-2\.0/);
    assert.match(body, /audio\.mp3/);
    assert.match(body, /FAKE_MP3_BYTES/);
    nativeHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'Native transcript' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const native = new XaiVoiceService({ apiKey: key,
      baseUrl: `https://127.0.0.1:${port}`, allowPrivateNetwork: true });
    assert.equal((await native.transcribe({
      audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg',
    })).text, 'Native transcript');
    assert.equal(nativeHits, 1);
    native.dispose();
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

async function assertCallerAbort(): Promise<void> {
  let notifyStarted: () => void = () => {};
  let notifyClosed: () => void = () => {};
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Wait until the fake upstream has the entire request. */ }
    res.once('close', () => notifyClosed());
    notifyStarted();
    // An upstream without a response must be disconnected when the caller aborts.
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client: VoiceHttpClient = {
    request: (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init),
  };
  const voice = new XaiVoiceService({ apiKey: key }, client);
  try {
    for (const operation of ['transcribe', 'synthesize'] as const) {
      const started = new Promise<void>(resolve => { notifyStarted = resolve; });
      const closed = new Promise<void>(resolve => { notifyClosed = resolve; });
      const controller = new AbortController();
      const request = operation === 'transcribe'
        ? voice.transcribe({ audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' },
          'member-one', 'workspace-one', controller.signal)
        : voice.synthesize({ text: 'cancel-this-request' }, 'member-one', 'workspace-one', controller.signal);
      await started;
      controller.abort();
      await assert.rejects(request, /request failed/);
      await closed;
    }
  } finally {
    voice.dispose();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}

async function startGateway(home: string, fakePort: number) {
  const extensionsDir = join(home, 'extension-fixtures');
  await mkdir(extensionsDir);
  for (const id of ['voice-xai', 'sample-ts']) {
    const source = join(repo, 'extensions', id);
    const manifest = JSON.parse(await readFile(join(source, 'neo.extension.json'), 'utf8'));
    manifest.runtime.entry = './index.mjs';
    await mkdir(join(extensionsDir, id));
    await writeFile(join(extensionsDir, id, 'neo.extension.json'), JSON.stringify(manifest));
    await writeFile(join(extensionsDir, id, 'index.mjs'),
      `export { default } from ${JSON.stringify(pathToFileURL(join(source, 'src', 'index.ts')).href)};`);
  }
  return createGateway({
    databaseFile: join(home, 'gateway.db'), dataDir: home, extensionsDir, mode: 'desktop',
    voiceHttpClient: {
      request: (url, init) => {
        assert.equal(new URL(url).origin, 'https://api.x.ai');
        return fetch(`http://127.0.0.1:${fakePort}${new URL(url).pathname}`, init);
      },
    },
  });
}

async function main() {
  const fake = await startFake();
  const home = await mkdtemp(join(tmpdir(), 'nmh-voice-xai-'));
  let app: Awaited<ReturnType<typeof startGateway>> | undefined;
  const logged: string[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { logged.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    // The HTTP boundary is injectable without a gateway or a real credential.
    const calls: string[] = [];
    const injected: VoiceHttpClient = {
      request: async (url, init) => {
        calls.push(new URL(url).pathname);
        assert.equal(init.redirect, 'error');
        assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${key}`);
        return new Response(JSON.stringify({ text: 'Injected transcript' }), {
          headers: { 'content-type': 'application/json' }, status: 200,
        });
      },
    };
    const independent = new XaiVoiceService({ apiKey: key }, injected);
    assert.equal((await independent.transcribe({ audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' })).text, 'Injected transcript');
    assert.deepEqual(calls, ['/v1/stt']);
    await assertNativeMultipartStt(home);
    await assertCallerAbort();
    await assert.rejects(independent.synthesize({ text: 'x'.repeat(15_001) }), /too_big|<=15000|15000|maximum|less than or equal/i);
    for (const blockedIp of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.0.1', '::1']) {
      const host = blockedIp.includes(':') ? `[${blockedIp}]` : blockedIp;
      assert.throws(() => validateEgressUrl(`https://${host}`), /denied/);
    }
    assert.throws(() => validateEgressUrl('http://1.1.1.1', true), /HTTPS/);
    await assert.rejects(new XaiVoiceService({ apiKey: key,
      baseUrl: `http://127.0.0.1:${fake.port}`, allowPrivateNetwork: true }, injected)
      .transcribe({ audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' }), /HTTPS/);

    let paidCalls = 0;
    const audioClient: VoiceHttpClient = { request: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      paidCalls++;
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
    } };
    const limited = new XaiVoiceService({ apiKey: key, requestsPerMinute: 1 }, audioClient);
    await limited.synthesize({ text: 'one' }, 'member-one');
    await limited.synthesize({ text: 'two' }, 'member-two');
    await assert.rejects(limited.synthesize({ text: 'three' }, 'member-one'), /rate limit exceeded/);
    assert.equal(paidCalls, 2);
    const html = new XaiVoiceService({ apiKey: key }, { request: async () =>
      new Response('<html>private body</html>', { headers: { 'content-type': 'text/html' } }) });
    await assert.rejects(html.synthesize({ text: 'hi' }), /invalid audio type/);
    const longAudio = Buffer.alloc(1_500_000, 7);
    const largeBinary = new XaiVoiceService({ apiKey: key }, { request: async () =>
      new Response(longAudio, { headers: { 'content-type': 'audio/mpeg' } }) });
    assert.equal((await largeBinary.synthesize({ text: 'x'.repeat(15_000) })).audioBase64,
      longAudio.toString('base64'));
    const largeJson = new XaiVoiceService({ apiKey: key }, { request: async () =>
      new Response(JSON.stringify({ audio: longAudio.toString('base64'), content_type: 'audio/mpeg' }),
        { headers: { 'content-type': 'application/json' } }) });
    assert.equal((await largeJson.synthesize({ text: 'x'.repeat(15_000) })).audioBase64,
      longAudio.toString('base64'));
    const transcriptOverflow = new XaiVoiceService({ apiKey: key }, { request: async () =>
      new Response(Buffer.alloc(128_001), { headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(transcriptOverflow.transcribe({
      audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg',
    }), /request failed|too large/);
    const oversize = new XaiVoiceService({ apiKey: key }, { request: async () =>
      new Response(new Uint8Array(1), { headers: {
        'content-type': 'audio/mpeg', 'content-length': '100000000',
      } }) });
    await assert.rejects(oversize.synthesize({ text: 'hi' }), /request failed|too large/);
    independent.dispose();
    await assert.rejects(independent.transcribe({ audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' }), /disabled/);

    app = await startGateway(home, fake.port);
    const base = `http://127.0.0.1:${app.port}`;
    const headers = { authorization: `Bearer ${app.desktopToken!}` };
    const rpc = createORPCClient<Client>(new RPCLink({ url: base, headers: () => headers }));
    assert.equal((await fetch(`${base}/x/voice-xai/status`)).status, 401);
    await rpc.extensions.enable({ id: 'sample-ts' });
    const saved = await rpc.settings.set({ extension: 'voice-xai', values: {
      apiKey: key, baseUrl: 'https://api.x.ai', allowPrivateNetwork: false, requestsPerMinute: 12,
    } });
    assert.equal(JSON.stringify(saved).includes(key), false);
    const settings = await rpc.settings.get({ extension: 'voice-xai' });
    assert.deepEqual(settings.values.apiKey, { set: true });
    assert.equal((await rpc.extensions.enable({ id: 'voice-xai' })).status, 'running');
    assert.deepEqual(await rpc.x['voice-xai'].status(), { providerId: 'xai', configured: true });
    assert.deepEqual(await rpc.x['voice-xai'].transcribe({
      audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg', language: 'en',
    }), { text: 'Fake transcript', language: 'en', duration: 1.5 });
    assert.deepEqual(await rpc.x['voice-xai'].synthesize({ text: 'Hi there', voice: 'ara', language: 'hi' }), {
      audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg',
    });
    assert.deepEqual(fake.hits, ['stt', 'tts']);
    for (const kind of ['stt', 'tts'] as const) {
      const pending = fake.watchAbort(kind);
      const controller = new AbortController();
      const request = kind === 'stt'
        ? rpc.x['voice-xai'].transcribe({ audioBase64: Buffer.from('ABORT_GATEWAY_TEST').toString('base64'), mimeType: 'audio/mpeg' }, { signal: controller.signal })
        : rpc.x['voice-xai'].synthesize({ text: 'ABORT_GATEWAY_TEST' }, { signal: controller.signal });
      const within = async (promise: Promise<unknown>, event: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 8_000);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      };
      await within(pending.started, `${kind} upstream start`);
      controller.abort();
      await assert.rejects(request);
      await within(pending.closed, `${kind} upstream disconnect`);
    }
    assert.equal((await rpc.extensions.disable({ id: 'voice-xai' })).status, 'disabled');
    assert.equal((await fetch(`${base}/x/voice-xai/status`, { headers })).status, 404);
    assert.equal((await rpc.extensions.list()).find((ext) => ext.id === 'sample-ts')?.status, 'running');
    assert.deepEqual(await (await fetch(`${base}/x/sample-ts/hello`, { headers })).json(),
      { message: 'Hello from TypeScript' });
    assert.ok(!logged.join('').includes(key), 'Secret appeared in gateway stdout or stderr');
  } finally {
    await app?.close();
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    fake.server.closeAllConnections();
    await new Promise<void>((done) => fake.server.close(() => done()));
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await main();
console.log('P2-10 PASS authenticated=true stt=fake tts=fake secret=vault+redacted transport=injectable toggle=isolated');
