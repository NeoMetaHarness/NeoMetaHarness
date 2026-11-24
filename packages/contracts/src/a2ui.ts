import { oc } from '@orpc/contract';
import { z } from 'zod';

const actionInput = z.object({
  handle: z.uuid(),
  idempotencyKey: z.uuid(),
  fields: z.record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    z.union([z.string().max(1024), z.boolean()]),
  ).refine((fields) => Object.keys(fields).length <= 16),
}).strict();

const actionOutput = z.discriminatedUnion('engine', [
  z.object({ engine: z.literal('hermes'), runId: z.string(), conversationId: z.uuid() }),
  z.object({ engine: z.literal('t3'), sequence: z.number().int() }),
]);

export type A2uiActionInput = z.infer<typeof actionInput>;
export type A2uiActionResult = z.infer<typeof actionOutput>;
export const a2uiContract = { action: oc.input(actionInput).output(actionOutput) };
