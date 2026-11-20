import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppsRegistry, McpProjectionBridge } from '@neometaharness/kernel';
import type { VaultService } from '@neometaharness/vault';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import { AppsProjection } from '../../apps-composio/src/projection.js';
import { PresetWorkerHost } from '../src/worker-host.js';
import type { ModelFactory } from '../src/model.js';
class ScriptedApps extends LlmAdapter {
  private stage = 0;
  constructor(private readonly destructive: boolean) { super(); }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 } }); }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const stage = ++this.stage;
    if (stage <= 2) {
      const pattern = stage === 1 ? /^mcp__neo_apps__toolkits(?:_|$)/ : /^mcp__neo_apps__run(?:_|$)/;
      const tool = options.tools?.find(t => pattern.test(t.name)); assert.ok(tool, 'Worker must discover the apps MCP tool');
      const args = stage === 1 ? { provider: 'fake' } : { provider: 'fake', accountId: 'fake-account', action: this.destructive ? 'DELETE' : 'READ', arguments: {} };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: tool.name, arguments: JSON.stringify(args) } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Finished with actual tool evidence.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const home = await mkdtemp(join(tmpdir(), 'neo-worker-apps-')); const registry = new AppsRegistry(); const bridge = new McpProjectionBridge();
let executed = 0;
const detach = registry.register({ id: 'fake', toolkits: async () => [{ id: 'fake', name: 'Fake app' }], connect: async () => ({ id: 'fake-account', toolkit: 'fake', redirectUrl: 'https://fake.test/auth' }), describe: async request => ({ destructive: request.action === 'DELETE', summary: 'Fake action' }), execute: async () => { executed++; return { output: 'fake-result' }; } });
const gate = registry.attachGate({ async submit(input) { return input.destructive ? { status: 'approval', inboxId: 'fake-inbox' } : { status: 'completed', result: await input.execute() }; } });
let projection: AppsProjection;
const server = createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); const result = await projection.action({ authorization: req.headers.authorization, payload: JSON.parse(Buffer.concat(chunks).toString()) }); res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body)); });
await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
projection = new AppsProjection({ put: async () => {}, delete: async () => true } as unknown as VaultService, registry, () => base);
const models: ModelFactory = async (_role, input) => ({ adapter: new ScriptedApps(input.text === 'delete'), provider: `fake-${randomUUID()}`, model: 'scripted' });
const host = new PresetWorkerHost(models, undefined, undefined, bridge);
try {
  await bridge.attach(projection); await host.start(home, base);
  const read = await host.delegate('fake-bot', 'read'); assert.match(read.summary, /fake-result/); assert.equal(executed, 1);
  const pending = await host.delegate('fake-bot', 'delete'); assert.equal(pending.kind, 'question'); assert.match(pending.question!, /Nothing has executed/); assert.equal(executed, 1);
  console.log('APPS_PRESET_WORKER PASS pinned_DSH_loop=true real_MCP=true multiple_tools=true final_result=true approval_question=true no_destructive_execution=true');
} finally { await host.close(); await bridge.detach(projection); gate(); detach(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(home, { recursive: true, force: true }); }
