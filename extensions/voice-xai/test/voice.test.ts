import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { neoContract } from '@neometaharness/contracts';
import type { ContractRouterClient } from '@orpc/contract';
import { XaiVoiceService, type VoiceHttpClient } from '../src/index.js';
import { assertSafeProviderUrl } from '@neometaharness/kernel';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
type Client = ContractRouterClient<typeof neoContract>;
const key = 'FAKE_XAI_KEY_OFFLINE_TEST_78341';
const audio = Buffer.from('FAKE_MP3_BYTES');

async function bounded<T>(promise: Promise<T>, name: string, timeout = 35_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${name} timeout`)), timeout);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function startFake() {
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
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
  return { server, port: address.port, hits };
}

async function startGateway(home: string) {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(repo, 'apps/gateway'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NMH_HERMES_HOME: join(home, 'hermes'), NMH_DB_PATH: join(home, 'neo.sqlite'),
      NMH_EXTENSIONS_DIR: join(repo, 'extensions'), NMH_PORT: '0',
      NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (value: Buffer) => { stdout = (stdout + value.toString()).slice(-150_000); });
  child.stderr!.on('data', (value: Buffer) => { stderr = (stderr + value.toString()).slice(-150_000); });
  let token = '';
  const port = await bounded(new Promise<number>((done, reject) => {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();
      if (line.startsWith('GATEWAY_READY ')) {
        reader.close();
        done((JSON.parse(line.slice(14)) as { port: number }).port);
      }
    });
    child.once('exit', (code) => reject(new Error(`Gateway exited ${code}: ${stderr.slice(-500)}`)));
    child.once('error', reject);
  }), 'gateway startup');
  assert.ok(token.length > 16);
  return { child, port, token, logs: () => stdout + stderr };
}

async function main() {
  const fake = await startFake();
  const home = await mkdtemp(join(tmpdir(), 'nmh-voice-xai-'));
  let app: Awaited<ReturnType<typeof startGateway>> | undefined;
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
    await assert.rejects(independent.synthesize({ text: 'x'.repeat(15_001) }), /too_big|<=15000|15000|maximum|less than or equal/i);
    for (const blockedIp of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '192.168.0.1', '::1', '::ffff:127.0.0.1']) {
      await assert.rejects(assertSafeProviderUrl(new URL('https://test.example'), {
        resolveHost: async () => [blockedIp],
      }), /Private provider endpoint is disabled/);
    }
    await assert.rejects(assertSafeProviderUrl(new URL('http://1.1.1.1')), /requires HTTPS/);
    await assert.rejects(new XaiVoiceService({ apiKey: key, baseUrl: `http://127.0.0.1:${fake.port}` }, injected)
      .transcribe({ audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' }), /Private provider endpoint is disabled/);

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
    const oversize = new XaiVoiceService({ apiKey: key }, { request: async () =>
      new Response(new Uint8Array(8_000_001), { headers: { 'content-type': 'audio/mpeg' } }) });
    await assert.rejects(oversize.synthesize({ text: 'hi' }), /response too large/);    independent.dispose();
    await assert.rejects(independent.transcribe({ audioBase64: audio.toString('base64'), mimeType: 'audio/mpeg' }), /disabled/);

    app = await startGateway(home);
    const base = `http://127.0.0.1:${app.port}`;
    const headers = { authorization: `Bearer ${app.token}` };
    const rpc = createORPCClient<Client>(new RPCLink({ url: base, headers: () => headers }));
    assert.equal((await fetch(`${base}/x/voice-xai/status`)).status, 401);
    await rpc.extensions.enable({ id: 'sample-ts' });
    const saved = await rpc.settings.set({ extension: 'voice-xai', values: {
      apiKey: key, baseUrl: `http://127.0.0.1:${fake.port}`, allowPrivateNetwork: true, requestsPerMinute: 12,
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
    assert.equal((await rpc.extensions.disable({ id: 'voice-xai' })).status, 'disabled');
    assert.equal((await fetch(`${base}/x/voice-xai/status`, { headers })).status, 404);
    assert.equal((await rpc.extensions.list()).find((ext) => ext.id === 'sample-ts')?.status, 'running');
    assert.deepEqual(await (await fetch(`${base}/x/sample-ts/hello`, { headers })).json(),
      { message: 'Hello from TypeScript' });
    assert.ok(!app.logs().includes(key), 'Secret appeared in gateway stdout or stderr');
    console.log('P2-10 PASS authenticated=true stt=fake tts=fake secret=vault+redacted transport=injectable toggle=isolated');
  } finally {
    if (app?.child.connected) app.child.send('shutdown');
    if (app?.child && app.child.exitCode === null) {
      await bounded(new Promise<void>((done) => app!.child.once('exit', () => done())), 'gateway shutdown', 15_000)
        .catch(() => app!.child.kill('SIGKILL'));
    }
    fake.server.closeAllConnections();
    await new Promise<void>((done) => fake.server.close(() => done()));
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await main();
