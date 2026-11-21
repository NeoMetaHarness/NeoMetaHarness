import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VaultService } from '@neometaharness/vault';
import { ComputerRegistry } from '@neometaharness/computers';
import { ComputerMcpBridge } from '@neometaharness/kernel';
import { FakeComputerProvider } from '../../computer-fake/src/index.js';
import { ComputerProjection } from '../src/projection.js';
import { FakeMcpEngine } from './fake-engine.js';
const home = await mkdtemp(join(tmpdir(), 'neo-computer-mcp-'));
const records = new Map<string, string>();
const vault = { put: async (scope: unknown, name: string, value: string) => records.set(JSON.stringify([scope, name]), value), delete: async (scope: unknown, name: string) => records.delete(JSON.stringify([scope, name])) } as unknown as VaultService;
const registry = new ComputerRegistry(() => 'unused', () => {});
const detach = registry.registerProvider('fake', new FakeComputerProvider());
const bridge = new ComputerMcpBridge();
let projection: ComputerProjection;
const http = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const result = await projection.action({ authorization: req.headers.authorization, payload: JSON.parse(Buffer.concat(chunks).toString()) });
  res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
});
await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
const address = http.address(); assert.ok(address && typeof address !== 'string');
projection = new ComputerProjection(vault, registry, () => `http://127.0.0.1:${address.port}`);
const clients: FakeMcpEngine[] = [];
try {
  await bridge.attach(projection);
  const tokens: string[] = [];
  for (const engine of ['hermes', 'dsh', 'superagent'] as const) {
    const profile = engine === 'hermes' ? 'default' : 'test-profile';
    const engineHome = join(home, engine);
    await registry.attach('fake', engine); registry.assign(engine, profile, engine);
    const config = await bridge.ready(engine, profile, engineHome, 'default'); assert.ok(config);
    const binding = JSON.parse(await readFile(config.env.NEO_COMPUTER_MCP_BINDING, 'utf8'));
    tokens.push(binding.token); assert.match(binding.token, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(config).includes(binding.token));
    const client = new FakeMcpEngine(config); clients.push(client);
    const tools = await client.initialize();
    assert.deepEqual(tools.tools.map((tool: any) => tool.name).sort(), ['click', 'key', 'lease_status', 'navigate', 'screenshot', 'type']);
    const capture = await client.call('screenshot'); assert.equal(capture.content[0].type, 'image');
    assert.ok(!(await client.call('click', { x: 10, y: 20 })).isError);
    assert.ok((await client.call('key', { keys: 'DELETE' })).isError);
    assert.ok((await client.call('navigate', { url: 'https://blocked.test/' })).isError);
    await registry.lease(engine, 'human'); assert.ok((await client.call('type', { text: 'blocked' })).isError);
    assert.equal(JSON.parse((await client.call('lease_status')).content[0].text).holder, 'human');
    await registry.lease(engine, 'agent'); registry.kill(true); assert.ok((await client.call('click', { x: 1, y: 1 })).isError); registry.kill(false);
    const wrong = await projection.action({ authorization: `Bearer ${'0'.repeat(64)}`, payload: { engine, profile, action: { action: 'capture' } } }); assert.equal(wrong.status, 403);
  }
  assert.equal(new Set(tokens).size, 3); assert.equal(records.size, 3);
  const yaml = await readFile(join(home, 'hermes', 'config.yaml'), 'utf8');
  assert.ok(yaml.includes('mcp_servers') && yaml.includes('mcp-neo_computers'));
  for (const token of tokens) assert.ok(!yaml.includes(token));
  await bridge.detach(projection); assert.equal(records.size, 0);
  for (const client of clients) assert.ok((await client.call('screenshot')).isError);
  assert.ok(!(await readFile(join(home, 'hermes', 'config.yaml'), 'utf8')).includes('neo_computers'));
  console.log('PASS computer MCP projection: real stdio tools with three fake engine consumers, profile vault isolation, safety gates and hot-disable cleanup');
} finally {
  await Promise.all(clients.map((client) => client.close())); await bridge.detach(projection); await detach();
  http.closeAllConnections(); await new Promise<void>((done) => http.close(() => done())); await rm(home, { recursive: true, force: true });
}
