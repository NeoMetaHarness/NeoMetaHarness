export const name = 'neo-dsh-seams';
export const inject = ['computerUse', 'browserUse', 'llm'];

const response = 'Neo scripted DSH SDK reply.';

const adapter = {
  providerInfo(provider) { return { id: provider, name: provider }; },
  providerRetryPolicy() { return undefined; },
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  },
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) };
  },
  async *stream({ signal }) {
    if (signal?.aborted) throw signal.reason;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const text of ['Neo scripted ', 'DSH SDK reply.']) {
      if (signal?.aborted) throw signal.reason;
      yield { type: 'text-delta', index: 0, text };
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } };
    yield { type: 'usage', usage: { inputTokens: 6, outputTokens: 8 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

export function apply(ctx) {
  ctx.effect(() => ctx.computerUse.register('neo-computer-stub'));
  ctx.effect(() => ctx.browserUse.register('neo-browser-stub'));
  ctx.effect(() => ctx.llm.registerAdapter(['neo-scripted'], adapter));
  const computer = ctx.computerUse.providerName;
  const browser = ctx.browserUse.providerName;
  if (computer !== 'neo-computer-stub' || browser !== 'neo-browser-stub')
    throw new Error('Neo provider slots are not registered');
  process.stderr.write('NEO_REGISTRY computer=' + computer + ' browser=' + browser + '\n');
}
