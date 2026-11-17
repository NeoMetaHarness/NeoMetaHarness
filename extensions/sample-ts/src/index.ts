import { defineExtension } from '@neometaharness/kernel';

export default defineExtension({
  activate(ctx) {
    ctx.provide('sampleTsService', { greeting: 'Hello from TypeScript' });
    ctx.route('hello', () => ({ message: 'Hello from TypeScript' }));
    ctx.contribute('tools', { id: 'sample-ts.echo', name: 'Sample TypeScript echo' });
    ctx.health(() => ({ ok: true }));
  },
});
