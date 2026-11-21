import { defineExtension } from '@neometaharness/kernel';
import { SuccessMetrics } from './metrics.js';

export default defineExtension({
  activate(ctx) {
    const root = ctx.inject<string>('extensionDataDir');
    if (!root) throw new Error('Success metrics needs extension storage');
    const service = new SuccessMetrics(root);
    ctx.route('summary', ({ body }) => service.summary((body ?? {}) as {
      workspace?: string;
      onboardingCompletedAt?: string | null;
    }));
    ctx.health(() => ({ ok: true }));
  },
});
