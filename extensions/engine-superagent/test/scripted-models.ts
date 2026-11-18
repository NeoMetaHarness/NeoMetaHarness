import { randomUUID } from 'node:crypto';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ModelFactory } from '../src/model.js';

/** Deterministic model used only for isolated test runs. */
class TestEvalModel extends LlmAdapter {
  constructor(private readonly endpoint?: string) { super(); }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 } });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = options.messages[0]?.content;
    let decision = 'accept';
    const text = prompt?.find((part) => part.type === 'text')?.text ?? '{}';
    const request = JSON.parse(text) as { kind?: string; text?: string };
    if (request.kind === 'postmortem') {
      const reusable = /reusable/i.test(request.text ?? '');
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({
        worked: 'Delegation completed and report was reviewed', failed: 'No further issues observed',
        reusable, procedure: reusable ? 'Validate the request, delegate to the bot, and review its report.' : undefined,
      }) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (this.endpoint) {
      const response = await fetch(this.endpoint + '/evaluate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }), signal: options.signal,
      });
      if (!response.ok) throw new Error(`Scripted DSH Eval HTTP ${response.status}`);
      const result = await response.json() as { decision: string };
      decision = result.decision;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ decision }) } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }


}

/** Per-worker DSH preset. The Neo MCP tool never appears on the default or root agent. */
class TestWorkerModel extends LlmAdapter {
  private calls = 0;

  constructor(private tool: string, private readonly args: { botId: string; text: string },
    private readonly endpoint?: string) { super(); }

  selectTool(name: string): void { this.tool = name; }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 } });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const stage = ++this.calls;
    if (stage === 1 && !options.tools?.some((entry) => entry.name === this.tool)) {
      throw new Error('DSH model request was missing the worker MCP tool');
    }
    if (this.endpoint) {
      const response = await fetch(this.endpoint + '/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, tool: this.tool, args: this.args, tools: options.tools?.map((t) => t.name) }),
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`Scripted DSH model HTTP ${response.status}`);
      const answer = await response.json() as { action: 'delegate' | 'finish' };
      if (answer.action !== (stage === 1 ? 'delegate' : 'finish')) {
        throw new Error(`Unexpected scripted DSH model decision ${answer.action}`);
      }
    }
    if (stage === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId(randomUUID()), name: this.tool, arguments: JSON.stringify(this.args),
      } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Worker delegation finished.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}


export const createModelFactory: ModelFactory = async (role, input) => {
  const endpoint = process.env.NMH_SUPERAGENT_MODEL_URL;
  if (role === 'eval') return { adapter: new TestEvalModel(endpoint), provider: 'neo-eval', model: 'scripted' };
  const adapter = new TestWorkerModel('', { botId: input.botId, text: input.text }, endpoint);
  return { adapter, provider: `neo-worker-${randomUUID()}`, model: 'scripted', configureTool: (tool) => adapter.selectTool(tool) };
};
