import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit';

const home = resolve('.cache', 'dsh-home');
await mkdir(home, { recursive: true });
process.env.DSH_HOME = home;
const fixture = resolve('fixture-server.mjs');
const config = {
  transport: 'stdio', serverName: 'neo', command: process.execPath,
  args: [fixture], env: {}, cwd: process.cwd(), toolCallTimeoutMs: 15000,
  failOnStartupError: true, reconnect: { enabled: false },
};
const ctx = new Context();
let worker;
let standard;
let alternate;
let declared;
try {
  ctx.baseUrl = import.meta.url;
  await ctx.plugin(Loader);
  await mountAgentLoopTestDependencies(ctx);
  await mountAgentLoopTestHarness(ctx);
  await ctx.plugin(AgentPresets, { default: 'standard' });
  const mcpModule = import.meta.resolve('@deepseek-ai/dsh-mcp-client');
  declared = await ctx.plugin({ inject: ['agentPresets'], async *apply(owner) {
    yield await owner.agentPresets.register({ id: 'standard', plugins: [] });
    yield await owner.agentPresets.register({ id: 'neo-worker', plugins: [
      { id: 'neo-worker-mcp', name: mcpModule, config },
    ] });
    // Same serverName in an independent preset composition is legal.
    yield await owner.agentPresets.register({ id: 'neo-worker-alt', plugins: [
      { id: 'neo-worker-alt-mcp', name: mcpModule, config },
    ] });
  } });
  const roster = await ctx.agentPresets.list();
  console.log('PRESET_ROSTER', JSON.stringify(roster));
  assert.equal(roster.find(x => x.id === 'neo-worker')?.broken, undefined);
  const make = (id,preset) => ctx.agents.create({
    sessionId: SessionId(id),
    setup: async owner => { await ctx.agentPresets.mount(owner,preset); },
  });
  worker = await make('neo-worker-spike','neo-worker');
  standard = await make('neo-standard-spike','standard');
  alternate = await make('neo-worker-alt-spike','neo-worker-alt');
  const name = 'mcp__neo__add';
  const names = owner => ctx.tools.schemas(owner.agent).map(x => x.name);
  assert.ok(names(worker).includes(name), JSON.stringify(names(worker)));
  assert.ok(!names(standard).includes(name));
  assert.ok(ctx.tools.get(name, worker.agent));
  assert.equal(ctx.tools.get(name, standard.agent), undefined);
  assert.ok(ctx.tools.get(name, alternate.agent));
  assert.equal(ctx.tools.get(name), undefined);
  const call = async (tool, args) => executeToolFixture(ctx, {
    callId: `neo-${tool}-${Date.now()}`, signal: new AbortController().signal,
    name: tool, arguments: args, agent: worker.agent,
  });
  const add = await call(name,{a:20,b:22});
  assert.equal(add.isError,false, JSON.stringify(add));
  assert.equal(add.content[0].text,'42');
  const fail = await call('mcp__neo__fail',{});
  assert.equal(fail.isError,true,JSON.stringify(fail));
  console.log('MCP_WORKER PASS worker/alternate have tools, standard/root absent; serverName reused across presets');
  console.log('MCP_STDIO PASS add(20,22)=42; fail returned isError=true');
  await worker.dispose();
  worker = undefined;
  await standard.dispose();
  standard = undefined;
  await alternate.dispose();
  alternate = undefined;
  await declared.dispose();
  declared = undefined;
  assert.deepEqual(await ctx.agentPresets.list(), []);
  assert.equal(ctx.tools.get(name), undefined);
  console.log('MCP_DISPOSE PASS agents and preset definitions removed; root has no MCP tool');
} finally {
  if (worker) await worker.dispose();
  if (standard) await standard.dispose();
  if (alternate) await alternate.dispose();
  if (declared) await declared.dispose();
  await ctx.fiber.dispose();
}
