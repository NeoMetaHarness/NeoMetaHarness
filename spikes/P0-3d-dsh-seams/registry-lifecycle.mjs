import { Context } from '@deepseek-ai/cordis';
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use';
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use';
import assert from 'node:assert/strict';

const ctx = new Context();
const output = [];
try {
  await ctx.plugin(ComputerUseRegistry);
  await ctx.plugin(BrowserUseRegistry);
  for (const [name, service] of [['computerUse', ctx.computerUse], ['browserUse', ctx.browserUse]]) {
    assert.equal(service.providerName, undefined);
    const dispose = service.register('neo-first');
    assert.equal(service.providerName, 'neo-first');
    assert.throws(() => service.register('neo-duplicate'), /already registered/);
    await dispose();
    assert.equal(service.providerName, undefined);
    const nextDispose = service.register('neo-second');
    assert.equal(service.providerName, 'neo-second');
    await nextDispose();
    assert.equal(service.providerName, undefined);
    output.push(name + ' duplicate rejected / dispose released / re-register succeeded');
  }

  const owned = await ctx.plugin({
    name: 'neo-computer-browser-test',
    inject: ['computerUse', 'browserUse'],
    apply(scoped) {
      scoped.computerUse.register('neo-owned-computer');
      scoped.browserUse.register('neo-owned-browser');
    },
  });
  assert.equal(ctx.computerUse.providerName, 'neo-owned-computer');
  assert.equal(ctx.browserUse.providerName, 'neo-owned-browser');
  await owned.dispose();
  assert.equal(ctx.computerUse.providerName, undefined);
  assert.equal(ctx.browserUse.providerName, undefined);
  output.push('Cordis plugin unload released both provider slots');
  console.log('PASS REGISTRY', output.join('; '));
} finally {
  await ctx.fiber.dispose();
}
