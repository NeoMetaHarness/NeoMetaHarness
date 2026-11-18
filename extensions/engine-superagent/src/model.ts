import { randomUUID } from 'node:crypto';
import { LlmAdapter, ToolCallId, attributionHeaders } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { VaultService } from '@neometaharness/vault';

export type ModelRole = 'eval' | 'worker';
export interface ModelBinding {
  adapter: LlmAdapter;
  provider: string;
  model: string;
  configureTool?(tool: string): void;
}
export type ModelFactory = (role: ModelRole, input: { botId: string; text: string; mode?: string }) => Promise<ModelBinding>;

/** OpenAI-compatible model endpoint chosen through Neo configuration and scoped vault credentials. */
export class GatewayModelAdapter extends LlmAdapter {
  constructor(private readonly endpoint: string, private readonly credential: string | undefined,
    private readonly role: ModelRole) { super(); }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100000 } });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const instructions = this.role === 'eval'
      ? 'You are the Neo task evaluator. Decide whether the requested task should be accepted. Return only a JSON object with the exact shape {"decision":"accept"} or {"decision":"decline"}. No Markdown or extra text.'
      : 'You are the Neo delegation worker. The user message is JSON containing botId and text. Call the available agents.send_to_bot MCP tool once with those exact values. Wait for its tool result before answering. If the tool is unavailable, report the failure clearly.';
    const messages = options.messages.map((message) => {
      const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: text };
      if (message.role === 'assistant') {
        const toolCalls = message.content.filter((block) => block.type === 'tool-call').map((block) => ({
          id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments },
        }));
        return { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
      }
      return { role: message.role === 'developer' ? 'system' : message.role, content: text };
    });
    const response = await fetch(this.endpoint.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: options.signal,
      headers: { ...attributionHeaders(), 'content-type': 'application/json',
        ...(this.credential ? { authorization: `Bearer ${this.credential}` } : {}) },
      body: JSON.stringify({ model: options.model,
        messages: [{ role: 'system', content: [options.system, instructions].filter(Boolean).join('\n\n') }, ...messages],
        stream: false,
        ...(options.tools?.length ? { tools: options.tools.map((tool) => ({
          type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })) } : {}),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      }),
    });
    if (!response.ok) throw new Error(`Superagent LLM HTTP ${response.status}`);
    const result = await response.json() as {
      choices?: { message?: { content?: string; tool_calls?: {
        id?: string; function: { name: string; arguments: string };
      }[] } }[];
    };
    const answer = result.choices?.[0]?.message;
    if (!answer) throw new Error('Superagent LLM returned no message');
    let index = 0;
    if (answer.content) {
      yield { type: 'block-start', index, blockType: 'text' };
      yield { type: 'block-end', index: index++, block: { type: 'text', text: answer.content } };
    }
    for (const tool of answer.tool_calls ?? []) {
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'block-end', index: index++, block: { type: 'tool-call',
        id: ToolCallId(tool.id || randomUUID()), name: tool.function.name,
        arguments: tool.function.arguments } };
    }
    yield { type: 'finish', reason: { kind: answer.tool_calls?.length ? 'tool-calls' : 'stop' } };
  }
}

export function vaultModelFactory(vault?: VaultService): ModelFactory {
  return async (role) => {
    const scope = { kind: 'engine', workspaceId: 'default', subjectId: 'engine-superagent' } as const;
    const endpoint = await vault?.get(scope, 'SUPERAGENT_LLM_URL') || process.env.NMH_SUPERAGENT_LLM_URL;
    const model = await vault?.get(scope, 'SUPERAGENT_LLM_MODEL') || process.env.NMH_SUPERAGENT_LLM_MODEL;
    if (!endpoint || !model) throw new Error('Superagent model unavailable: configure SUPERAGENT_LLM_URL and SUPERAGENT_LLM_MODEL in the vault or NMH_SUPERAGENT_LLM_URL and NMH_SUPERAGENT_LLM_MODEL in the environment');
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Superagent model endpoint requires HTTP(S)');
    const credential = await vault?.get(scope, 'SUPERAGENT_API_KEY');
    // DSH registers adapters by provider name. Each worker turn owns its registration.
    return { adapter: new GatewayModelAdapter(url.href, credential, role), provider: `neo-superagent-${randomUUID()}`, model };
  };
}
