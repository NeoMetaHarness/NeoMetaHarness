import { join } from 'node:path';
import type { ComputerMcpBridge, McpProjectionBridge, SkillsBridge } from '@neometaharness/kernel';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-testkit';
import type { ModelFactory } from './model.js';
import { bridgeEnv } from './bridge-key.js';

/** Pinned DSH SDK server.ts:564-591 omits preset composition. This isolated host preserves preset-scoped MCP until SDK supports it. */
export interface WorkerHost {
  /** tokenFile holds the bridge API key; the MCP child re-reads it on every call. */
  start(home: string, gatewayUrl: string, tokenFile?: string): Promise<void>;
  delegate(botId: string, text: string, workspace?: string): Promise<{ summary: string; tests: string[]; risks: string[];
    kind?: 'question' | 'approval'; question?: string; destructive?: boolean }>;
  close(): Promise<void>;
}

export class PresetWorkerHost implements WorkerHost {
  constructor(private readonly models: ModelFactory, private readonly computers?: ComputerMcpBridge,
    private readonly skills?: SkillsBridge, private readonly appsMcp?: McpProjectionBridge) {}
  private readonly context = new Context();
  private registration?: { dispose(): Promise<void> };
  private active = new Set<{ dispose(): Promise<void> }>();
  private next = 0;
  private home = '';
  private readonly computerProfiles = new Map<string, string>();

  async start(home: string, gatewayUrl: string, tokenFile?: string): Promise<void> {
    this.home = home;
    await mkdir(home, { recursive: true });
    await this.skills?.dshReady('superagent', home);
    this.context.baseUrl = import.meta.url;
    await this.context.plugin(Loader);
    await mountAgentLoopTestDependencies(this.context);
    await mountAgentLoopTestHarness(this.context);
    await this.context.plugin(AgentPresets, { default: 'standard' });
    const serverFile = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));
    const mcpModule = import.meta.resolve('@deepseek-ai/dsh-mcp-client');
    this.registration = await this.context.plugin({
      inject: ['agentPresets'],
      async *apply(owner) {
        yield await owner.agentPresets.register({ id: 'standard', plugins: [] });
        yield await owner.agentPresets.register({ id: 'neo-superagent-worker', plugins: [{
          id: 'neo-superagent-mcp', name: mcpModule,
          config: {
            transport: 'stdio', serverName: 'neo', command: process.execPath,
            args: [serverFile, gatewayUrl], cwd: home,
            env: bridgeEnv(home, tokenFile), toolCallTimeoutMs: 180000,
            failOnStartupError: true, reconnect: { enabled: false },
          },
        }] });
      },
    });
  }

  async delegate(botId: string, text: string, workspace?: string): Promise<{ summary: string; tests: string[]; risks: string[];
    kind?: 'question' | 'approval'; question?: string; destructive?: boolean }> {
    const binding = await this.models('worker', { botId, text, workspace });
    const { adapter, provider, model } = binding;
    const computerProfile = botId;
    this.computerProfiles.set(`${workspace ?? 'default'}:${computerProfile}`, workspace ?? 'default');
    const profileHome = join(this.home, createHash('sha256').update(`${workspace ?? 'default'}:${computerProfile}`).digest('hex'));
    const computerMcp = await this.computers?.ready('superagent', computerProfile, profileHome, workspace ?? 'default');
    const appsMcp = await this.appsMcp?.ready('superagent', computerProfile, profileHome, workspace ?? 'default');
    // Every worker has its own model adapter, allowing concurrent assignments.
    const unregister = this.context.llm.registerAdapter([provider], adapter);
    let worker: Awaited<ReturnType<typeof this.context.agents.create>> | undefined;
    try {
      worker = await this.context.agents.create({
        sessionId: SessionId(`neo-superagent-${++this.next}-${randomUUID()}`),
        agentOptions: { provider, model },
        setup: async (owner) => {
          await this.context.agentPresets.mount(owner, 'neo-superagent-worker');
          // dsh-superagent@8c32a9dc5d72 cordis.patch.yml:20-26 (worker preset plugins);
          // DSH@0.2.2-rc.1 packages/mcp/mcp-client/src/index.ts:51-78,154 (stdio mount).
          if (appsMcp) await owner.plugin(await import('@deepseek-ai/dsh-mcp-client'), {
            ...appsMcp, cwd: this.home, toolCallTimeoutMs: 20000, failOnStartupError: false,
          });
          if (computerMcp) await owner.plugin(await import('@deepseek-ai/dsh-mcp-client'), {
            ...computerMcp, cwd: this.home, toolCallTimeoutMs: 15000, failOnStartupError: false,
          });
        },
      });
      this.active.add(worker);
      // DSH normalizes MCP tool names containing dots and adds a stable suffix.
      const available = this.context.tools.schemas(worker.agent).map((entry) => entry.name);
      const matching = available.filter((name) => /^mcp__neo__agents_send_to_bot_[a-f0-9]+$/.test(name));
      if (matching.length !== 1) {
        throw new Error(`DSH worker MCP delegation tool unavailable or ambiguous (available: ${available.join(', ')})`);
      }
      // Adapter choice is tied to this worker; the DSH agent loop selects and
      // executes the MCP tool from a real model turn.
      binding.configureTool?.(matching[0]!);
      worker.agent.followup(createUserMessage({
        content: [{ type: 'text', text: JSON.stringify({ botId, text }) }], source: { kind: 'user' },
      }));
      await worker.agent.whenIdle();
      const result = worker.agent.session.snapshotEvents().filter((event) => event.type === 'tool/result').at(-1);
      if (!result) throw new Error('DSH worker did not execute a Neo MCP tool');
      const output = result.data.message.content.find((part) => part.type === 'text');
      const message = output?.type === 'text' ? output.text : '';
      if (result.data.message.isError) throw new Error(message || 'Neo MCP tool failed');
      const parsed = JSON.parse(message) as { summary: string; tests?: string[]; risks?: string[];
        kind?: 'question' | 'approval'; question?: string; destructive?: boolean };
      if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('Worker tool produced no report summary');
      return { summary: parsed.summary, tests: parsed.tests ?? [], risks: parsed.risks ?? [],
        kind: parsed.kind, question: parsed.question, destructive: parsed.destructive };
    } finally {
      try {
        if (worker) {
          this.active.delete(worker);
          await worker.dispose();
        }
      } finally {
        unregister();
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.active].map((worker) => worker.dispose()));
    this.computerProfiles.set(`${workspace ?? 'default'}:${computerProfile}`, workspace ?? 'default');
    const profileHome = join(this.home, createHash('sha256').update(`${workspace ?? 'default'}:${computerProfile}`).digest('hex'));
    const computerMcp = await this.computers?.ready('superagent', computerProfile, profileHome, workspace ?? 'default');
    const appsMcp = await this.appsMcp?.ready('superagent', computerProfile, profileHome, workspace ?? 'default');
    this.computerProfiles.clear();
    this.skills?.forgetDsh('superagent');
    await this.registration?.dispose();
    await this.context.fiber.dispose();
  }
}
