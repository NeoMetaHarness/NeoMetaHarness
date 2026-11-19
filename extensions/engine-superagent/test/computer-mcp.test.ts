import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import type { VaultService } from '@neometaharness/vault';
import { ComputerRegistry } from '../../../packages/computers/src/index.js';
import { FakeComputerProvider } from '../../computer-fake/src/index.js';
import { ComputerProjection } from '../../computers-mcp/src/projection.js';
const home = await mkdtemp(join(tmpdir(), 'neo-pinned-computer-mcp-'));
const registry = new ComputerRegistry(() => 'unused', () => {});
const detach = registry.registerProvider('fake', new FakeComputerProvider());
let projection: ComputerProjection;
const http = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
  const result = await projection.action({ authorization: req.headers.authorization, payload: JSON.parse(Buffer.concat(chunks).toString()) });
  res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
});
await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
const address = http.address(); assert.ok(address && typeof address !== 'string');
projection = new ComputerProjection({ put: async () => {}, delete: async () => true } as unknown as VaultService, registry, () => `http://127.0.0.1:${address.port}`);
try {
  for (const engine of ['dsh', 'superagent'] as const) {
    const context = new Context();
    try {
      await mountAgentLoopTestDependencies(context); await mountAgentLoopTestHarness(context);
      await registry.attach('fake', engine); registry.assign(engine, 'profile', engine);
      const config = await projection.ready(engine, 'profile', join(home, engine), 'default');
      await context.plugin(McpClient, { ...config, cwd: home, toolCallTimeoutMs: 15000, failOnStartupError: true });
      const tool = context.tools.schemas().find((entry) => entry.name.includes('screenshot'));
      assert.ok(tool, 'Pinned MCP client must discover the computer tool');
      const result = await executeToolFixture(context, { callId: 'computer-test' as never, name: tool.name, arguments: {}, signal: new AbortController().signal });
      assert.ok(JSON.stringify(result).includes('image'), 'Pinned MCP tool execution returns screenshot image content');
    } finally { await context.fiber.dispose(); }
  }
  console.log('PASS pinned DSH MCP client: unmodified plugin discovers and executes screenshot for DSH and superagent configs, fake computer only');
} finally {
  await projection.removeAll(); await detach(); http.closeAllConnections(); await new Promise<void>((done) => http.close(() => done()));
  await rm(home, { recursive: true, force: true });
}
