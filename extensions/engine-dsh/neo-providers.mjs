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

export function apply(ctx) {
  if (process.env.NEO_TEST_SECRET !== undefined) throw new Error('DSH inherited a parent-only secret');
  ctx.effect(() => ctx.computerUse.register(
    process.env.NEO_COMPUTER_ENDPOINT ? 'neo-gateway' : 'neo-computer-stub'));
  ctx.effect(() => ctx.browserUse.register('neo-browser-stub'));
  ctx.effect(() => ctx.llm.registerAdapter(['neo-scripted'], scriptedAdapter));
}
