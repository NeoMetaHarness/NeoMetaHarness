import type { T3Event } from '@neometaharness/contracts';

/** Merge consecutive text chunks over a 33 ms window without moving control events. */
export async function* coalesceText(source: AsyncIterable<T3Event>, windowMs = 33): AsyncGenerator<T3Event> {
  const iterator = source[Symbol.asyncIterator]();
  let reading: Promise<IteratorResult<T3Event>> | undefined;
  let pending: T3Event | undefined;
  let deadline = 0;
  try {
    while (true) {
      reading ??= iterator.next();
      let result: IteratorResult<T3Event> | undefined;
      if (pending) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const remaining = Math.max(0, deadline - Date.now());
        try {
          result = await Promise.race([
            reading,
            new Promise<undefined>((done) => { timeout = setTimeout(() => done(undefined), remaining); }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        if (!result) {
          yield pending;
          pending = undefined;
          continue;
        }
      } else {
        result = await reading;
      }
      reading = undefined;
      if (result.done) {
        if (pending) yield pending;
        break;
      }
      const event = result.value;
      if (event.kind === 'text.delta' && event.textDelta !== undefined) {
        if (pending && pending.messageId === event.messageId) {
          pending = {
            ...pending, sequence: event.sequence, payload: event.payload,
            // T3 message.updated contains a complete revision. Keep the most recent one.
            textDelta: pending.fullText && event.fullText
              ? event.textDelta : (pending.textDelta ?? '') + event.textDelta,
            coalescedCount: (pending.coalescedCount ?? 1) + 1,
          };
        } else {
          if (pending) yield pending;
          pending = { ...event, coalescedCount: 1 };
          deadline = Date.now() + windowMs;
        }
      } else {
        if (pending) {
          yield pending;
          pending = undefined;
        }
        yield event;
      }
    }
  } finally {
    await iterator.return?.();
  }
}
