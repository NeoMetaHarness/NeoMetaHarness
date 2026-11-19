import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';

import { createInterface } from 'node:readline';

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join, resolve } from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

import { createORPCClient } from '@orpc/client';

import { RPCLink } from '@orpc/client/fetch';

import type { ContractRouterClient } from '@orpc/contract';

import { neoContract, type GatewayEvent } from '@neometaharness/contracts';

import { FakeMcpEngine } from './fake-engine.js';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const home = await mkdtemp(join(tmpdir(), 'neo-p37-gateway-'));

const sources = join(home, 'source'); await mkdir(sources);

async function extension(id: string, code: string) {

  const dir = join(sources, id); await mkdir(dir);

  await writeFile(join(dir, 'neo.extension.json'), JSON.stringify({ id, displayName: id, version: '0.1.0', kind: ['tool'], runtime: { type: 'cordis', entry: './index.mjs' } }));

  await writeFile(join(dir, 'index.mjs'), code);

}

await extension('computers-mcp', `export { default } from ${JSON.stringify(pathToFileURL(join(repo, 'extensions/computers-mcp/src/index.ts')).href)};`);

await extension('fake-screens', `export default { activate(ctx) {

  const registry = ctx.inject('computers');

  for (const id of ['fake','headless-chrome','local-sandbox','vnc']) ctx.effect(() => registry.registerProvider(id, {

    capabilities: { screen:true,input:true,browserCdp:false,shell:false,files:false,snapshot:false },

    attach() { return { screen:()=>({protocol:'png'}), lease(){}, input(){}, navigate(){}, capture(){ return { png:'iVBORw0KGgo=',width:1,height:1 }; } }; },

    provision(){return this.attach();}, release(){}

  }));

} };`);

for (const engine of ['hermes', 'dsh', 'superagent']) {

  await extension(`fake-${engine}`, `import { join } from 'node:path'; import { mkdir,writeFile } from 'node:fs/promises';

export default { async activate(ctx) {

  const bridge=ctx.inject('computerMcpBridge'); const home=join(ctx.inject('extensionDataDir'),'fake-${engine}');

  const config=await bridge.ready('${engine}','profile-${engine}',home);

  await mkdir(home,{recursive:true}); await writeFile(join(home,'config.json'),JSON.stringify(config));

  ctx.effect(()=>()=>bridge.forget('${engine}','profile-${engine}')); ctx.health(()=>({ok:true}));

} };`);

}

const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(repo, 'apps/gateway/src/main.ts')], {

  cwd: repo, env: { ...process.env, NEO_MODE: 'desktop', NEO_PRINT_DESKTOP_TOKEN: '1', NMH_DB_PATH: join(home, 'gateway.db'), NMH_EXTENSIONS_DIR: sources, NMH_PORT: '0' },

  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,

});

let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; });

const exited = new Promise<void>((done) => child.once('exit', () => done()));

const clients: FakeMcpEngine[] = [];

try {

  let token = '';

  const port = await new Promise<number>((done, reject) => {

    const timer = setTimeout(() => reject(Error('Gateway startup timed out')), 30000);

    const reader = createInterface({ input: child.stdout });

    reader.on('line', (line) => {

      if (line.startsWith('NEO_DESKTOP_TOKEN ')) token = line.slice(18).trim();

      if (line.startsWith('GATEWAY_READY ')) { clearTimeout(timer); reader.close(); done(JSON.parse(line.slice(14)).port); }

    });

    child.once('exit', () => { clearTimeout(timer); reject(Error('Gateway startup failed: ' + logs.slice(-1000))); });

  });

  assert.ok(token.length > 16);

  const base = `http://127.0.0.1:${port}`;

  const rpc = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({ url: base, headers: { authorization: `Bearer ${token}` } }));

  const unauth = createORPCClient<ContractRouterClient<typeof neoContract>>(new RPCLink({ url: base }));

  await assert.rejects(unauth.computers.policy.set({ id: 'missing', allowDestructiveKeys: true, navigationOrigins: [] }), (error: any) => error.code === 'UNAUTHORIZED');

  assert.equal((await rpc.extensions.enable({ id: 'fake-screens' })).status, 'running');

  assert.equal((await rpc.extensions.enable({ id: 'computers-mcp' })).status, 'running');

  const secrets: string[] = [];

  const bindings: any[] = [];

  for (const engine of ['hermes', 'dsh', 'superagent'] as const) {

    assert.equal((await rpc.extensions.enable({ id: `fake-${engine}` })).status, 'running');

    const config = JSON.parse(await readFile(join(home, 'extensions', `fake-${engine}`, 'config.json'), 'utf8'));

    const binding = JSON.parse(await readFile(config.env.NEO_COMPUTER_MCP_BINDING, 'utf8')); bindings.push(binding); secrets.push(binding.token);

    const client = new FakeMcpEngine(config); clients.push(client); await client.initialize();

    for (const providerId of ['fake', 'headless-chrome', 'local-sandbox', 'vnc']) {

      const id = `${engine}-${providerId}`;

      await rpc.computers.attach({ providerId, target: id });

      await rpc.computers.assign({ engine, targetId: `profile-${engine}`, computerId: id });

      assert.equal((await client.call('screenshot')).content[0].type, 'image');

      assert.ok(!(await client.call('click', { x: 1, y: 1 })).isError);

      assert.ok(!(await client.call('type', { text: 'NEVER_IN_AUDIT' })).isError);

      await rpc.computers.lease({ id, holder: 'human' });

      assert.ok((await client.call('click', { x: 1, y: 1 })).isError);

      assert.equal(JSON.parse((await client.call('lease_status')).content[0].text).holder, 'human');

      await rpc.computers.lease({ id, holder: 'agent' });

      await rpc.computers.kill({ engaged: true }); assert.ok((await client.call('screenshot')).isError); await rpc.computers.kill({ engaged: false });

      assert.ok((await client.call('key', { keys: 'CTRL+ALT+DELETE' })).isError);

      assert.ok((await client.call('navigate', { url: 'https://allowed.test/' })).isError);

      await rpc.computers.policy.set({ id, allowDestructiveKeys: true, navigationOrigins: ['https://allowed.test'] });

      assert.ok(!(await client.call('key', { keys: 'DELETE' })).isError);

      assert.ok(!(await client.call('navigate', { url: 'https://allowed.test/page' })).isError);

      assert.ok((await client.call('navigate', { url: 'file:///etc/passwd' })).isError);

    }

  }

  assert.equal(new Set(secrets).size, 3);

  const forged = await fetch(base + '/internal/computers-mcp/action', { method: 'POST', headers: { authorization: `Bearer ${secrets[0]}`, 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'dsh', profile: 'profile-dsh', action: { action: 'capture' } }) });

  assert.equal(forged.status, 403);

  const events: GatewayEvent[] = [];

  const stream = await rpc.events.subscribe({ since: 0 });

  for await (const event of stream) {

    events.push(event);

    if (event.type === 'computer.action' && event.computerId === 'superagent-vnc' && event.action === 'navigate' && event.outcome === 'denied') break;

  }

  for (const providerId of ['fake', 'headless-chrome', 'local-sandbox', 'vnc']) {

    const audit = events.filter((event) => event.type === 'computer.action' && event.providerId === providerId);

    assert.ok(audit.some((event: any) => event.outcome === 'allowed') && audit.some((event: any) => event.outcome === 'denied'));

  }

  assert.ok(!JSON.stringify(events).includes('NEVER_IN_AUDIT'));

  assert.equal((await rpc.extensions.disable({ id: 'computers-mcp' })).status, 'disabled');

  for (const client of clients) assert.ok((await client.call('screenshot')).isError);

  for (const binding of bindings) assert.equal((await fetch(binding.endpoint, { method: 'POST', headers: { authorization: `Bearer ${binding.token}` }, body: '{}' })).status, 404);

  for (const engine of ['hermes', 'dsh', 'superagent']) assert.equal((await rpc.extensions.list()).find((item) => item.id === `fake-${engine}`)?.health?.ok, true);

  assert.equal((await rpc.extensions.enable({ id: 'computers-mcp' })).status, 'running');

  assert.ok(!(await clients[0]!.call('screenshot')).isError);

  const old = bindings[0];

  assert.equal((await fetch(old.endpoint, { method: 'POST', headers: { authorization: `Bearer ${old.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ engine: old.engine, profile: old.profile, action: { action: 'capture' } }) })).status, 403);

  for (const secret of secrets) assert.ok(!logs.includes(secret));

  console.log('PASS P3-7 authenticated Gateway: real MCP tools, 3 fake engines x 4 provider doubles, profile capability isolation, lease/kill/policy audit and disabled-healthy re-enable');

} finally {

  await Promise.all(clients.map((client) => client.close()));

  child.stdin.write('shutdown\n'); const timer = setTimeout(() => child.kill(), 5000); await exited; clearTimeout(timer);

  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });

}

