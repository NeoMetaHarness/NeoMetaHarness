import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'neo-dsh-providers';
export const inject = ['computerUse', 'browserUse', 'llm'];

const scriptedReply = 'Neo scripted DSH SDK reply.';
let scriptedToolCalled = false;
const scriptedAdapter = {
  providerInfo(provider) { return { id: provider, name: provider }; },
  providerRetryPolicy() { return undefined; },
  async resolveModel(provider, model) { return { provider, id: model, name: model }; },
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) };
  },
  async *stream({ signal, messages }) {
    if (signal?.aborted) throw signal.reason;
    // The scripted adapter is a fixture. Record its actual model input in the isolated DSH home.
    if (process.env.DSH_HOME) {
      appendFileSync(join(process.env.DSH_HOME, 'scripted-model-input.jsonl'), JSON.stringify(messages) + '\n');
    }
    if (process.env.NEO_COMPUTER_ENDPOINT && !scriptedToolCalled
        && JSON.stringify(messages).includes('trigger_neo_computer')) {
      scriptedToolCalled = true;
      for (const [index, action] of [
        { action: 'click', x: 42, y: 84 }, { action: 'capture' },
      ].entries()) {
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id: `neo-call-${index}`, name: 'neo_computer',
          argumentsDelta: JSON.stringify(action) };
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const text of ['Neo scripted ', 'DSH SDK reply.']) {
      if (signal?.aborted) throw signal.reason;
      yield { type: 'text-delta', index: 0, text };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: scriptedReply } };
    yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

const hubAdapter = {
  providerInfo(provider) { return { id: provider, name: provider }; },
  providerRetryPolicy() { return undefined; },
  async resolveModel(provider, model) { return { provider, id: model, name: model }; },
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) };
  },
  async *stream({ signal, messages, tools }) {
    const baseUrl = process.env.NEO_MODEL_BASE_URL;
    if (!baseUrl || !process.env.NEO_MODEL_NAME) throw new Error('DSH Model Hub selection unavailable');
    const body = {
      model: process.env.NEO_MODEL_NAME,
      stream: false,
      // DSH Message/ToolSchema seam: packages/llm/llm/src/message.ts:143,173
      // and types.ts:517 at pinned 0.2.2-rc.1. Preserve tool call/result identity.
      messages: messages.map((message) => {
        const blocks = Array.isArray(message.content) ? message.content : [];
        const content = typeof message.content === 'string' ? message.content
          : blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content };
        const calls = blocks.filter(block => block.type === 'tool-call').map(block => ({
          id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments },
        }));
        return { role: message.role === 'developer' ? 'system' : message.role, content,
          ...(calls.length ? { tool_calls: calls } : {}) };
      }),
      ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.parameters,
      } })) } : {}),
    };
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json',
        ...(process.env.NEO_MODEL_API_KEY ? { authorization: `Bearer ${process.env.NEO_MODEL_API_KEY}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`DSH model request failed with HTTP ${response.status}`);
    const result = await response.json();
    const choice = result.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (content) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: content };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: content } };
    }
    for (const [index, tool] of (choice?.message?.tool_calls ?? []).entries()) {
      yield { type: 'block-start', index: index + 1, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: index + 1, id: tool.id,
        name: tool.function.name, argumentsDelta: tool.function.arguments };
    }
    if (result.usage) yield { type: 'usage', usage: {
      inputTokens: result.usage.prompt_tokens ?? 0, outputTokens: result.usage.completion_tokens ?? 0,
    } };
    yield { type: 'finish', reason: { kind: choice?.finish_reason === 'tool_calls' ? 'tool-calls' : 'stop' } };
  },
};

export function apply(ctx) {
  if (process.env.NEO_TEST_SECRET !== undefined) throw new Error('DSH inherited a parent-only secret');
  ctx.effect(() => ctx.computerUse.register(
    process.env.NEO_COMPUTER_ENDPOINT ? 'neo-gateway' : 'neo-computer-stub'));
  ctx.effect(() => ctx.browserUse.register('neo-browser-stub'));
  ctx.effect(() => ctx.llm.registerAdapter(['neo-scripted'], scriptedAdapter));
  ctx.effect(() => ctx.llm.registerAdapter(['neo-model-hub'], hubAdapter));
}
