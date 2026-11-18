import { defineExtension } from '@neometaharness/kernel';

export interface SampleTsSettings {
  greeting?: string;
  maxRetries?: number;
  apiSecret?: string;
}

export default defineExtension({
  activate(ctx) {
    const settings = ctx.inject<SampleTsSettings>('settings');
    ctx.provide('sampleTsService', {
      get greeting() {
        return settings?.greeting ?? 'Hello from TypeScript';
      },
    });
    ctx.route('hello', () => ({ message: settings?.greeting ?? 'Hello from TypeScript' }));
    ctx.route('config', () => ({
      greeting: settings?.greeting ?? 'Hello from TypeScript',
      maxRetries: settings?.maxRetries ?? 3,
      hasSecret: Boolean(settings?.apiSecret),
      apiSecret: settings?.apiSecret,
    }));
    ctx.contribute('tools', { id: 'sample-ts.echo', name: 'Sample TypeScript echo' });
    ctx.health(() => ({ ok: true }));
  },
});
