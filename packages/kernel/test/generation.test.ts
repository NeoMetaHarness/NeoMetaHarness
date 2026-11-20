import assert from 'node:assert/strict';
import { ExtensionGeneration } from '../src/generation.js';
const generation = new ExtensionGeneration('sample-ts');
let done!: () => void;
const gate = new Promise<void>((resolve) => { done = resolve; });
let disposed = false; let closed = false;
generation.cleanup = async () => { disposed = true; };
generation.onDrain(() => { closed = true; });
const request = generation.invoke(async () => { await gate; return 'v1'; }, 'GET');
const retiring = generation.dispose(1000);
await Promise.resolve();
assert.equal(disposed, false); assert.equal(closed, true);
done(); assert.equal(await request, 'v1'); await retiring; assert.equal(disposed, true);
await assert.rejects(generation.invoke(() => 'late', 'GET'), /draining/);
const streamGeneration = new ExtensionGeneration('sample-ts');
const stream = await streamGeneration.invoke(async function* () { yield 'v1'; }, 'GET') as AsyncIterableIterator<string>;
await stream.return!(); await streamGeneration.dispose(1000);
const timeoutGeneration = new ExtensionGeneration('sample-ts');
const aborted = timeoutGeneration.invoke(({ signal }) => new Promise((resolve) => signal!.addEventListener('abort', () => resolve('closed'))), 'GET');
await timeoutGeneration.dispose(10); assert.equal(await aborted, 'closed');
// Tracking/draining must not catch, replace, retry or replay a route failure.
const errorGeneration = new ExtensionGeneration('sample-ts');
const routeError = new Error('GitHub polling paused after HTTP 429');
let invocations = 0;
await assert.rejects(errorGeneration.invoke(() => { invocations++; throw routeError; }, 'RPC'),
  error => error === routeError);
await assert.rejects(errorGeneration.invoke(() => { invocations++; return Promise.reject(routeError); }, 'RPC'),
  error => error === routeError);
let rejectPending!: (reason: unknown) => void;
const upstream = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
const failing = errorGeneration.invoke(() => { invocations++; return upstream; }, 'RPC');
const observed = assert.rejects(failing, error => error === routeError);
const draining = errorGeneration.dispose(1000);
rejectPending(routeError);
await observed; await draining;
assert.equal(invocations, 3, 'Each admitted request invokes its handler exactly once, including during drain');
console.log('PASS staged generation: request drain, connection closure, unopened iterator release and bounded abort');
console.log('PASS route failures: unchanged sync/async/draining errors and exactly one handler invocation');
