import type { T3Event } from '@neometaharness/contracts';
import { coalesceText } from './coalesce.js';

/** Batch terminal bytes at the Gateway; preserve snapshots and lifecycle ordering. */
export async function* coalesceTerminal(source: AsyncIterable<any>) {
  async function* frames(): AsyncGenerator<T3Event> {
    for await (const event of source) {
      yield event.type === 'output' && typeof event.data === 'string'
        ? { kind: 'text.delta', messageId: event.terminalId, textDelta: event.data, payload: event }
        : { kind: 'event', payload: event };
    }
  }
  for await (const frame of coalesceText(frames())) {
    yield frame.kind === 'text.delta'
      ? { ...frame.payload as object, data: frame.textDelta }
      : frame.payload;
  }
}
