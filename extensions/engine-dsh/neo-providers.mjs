export const name = 'neo-dsh-providers';
export const inject = ['computerUse', 'browserUse', 'llm'];

const scriptedReply = 'Neo scripted DSH SDK reply.';
const scriptedAdapter = {
  providerInfo(provider) { return { id: provider, name: provider }; },
  providerRetryPolicy() { return undefined; },
  async resolveModel(provider, model) { return { provider, id: model, name: model }; },
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) };
  },
  async *stream({ signal }) {
    if (signal?.aborted) throw signal.reason;
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
  ctx.effect(() => ctx.computerUse.register('neo-computer-stub'));
  ctx.effect(() => ctx.browserUse.register('neo-browser-stub'));
  ctx.effect(() => ctx.llm.registerAdapter(['neo-scripted'], scriptedAdapter));
}
