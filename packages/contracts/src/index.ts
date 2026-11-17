import { oc, eventIterator } from '@orpc/contract';
import { z } from 'zod';

export const extensionStatusSchema = z.object({
  id: z.string(),
  desired: z.boolean(),
  status: z.enum(['running', 'disabled', 'degraded']),
  reason: z.string().optional(),
  health: z.object({ ok: z.boolean(), pid: z.number().optional() }).optional(),
});

export const gatewayEventSchema = z.object({
  seq: z.number().int(),
  extensionId: z.string(),
  status: z.enum(['running', 'disabled', 'degraded']),
  type: z.literal('extension.state'),
});

export type GatewayEvent = z.infer<typeof gatewayEventSchema>;
export type ExtensionStatus = z.infer<typeof extensionStatusSchema>;

export const neoContract = {
  extensions: {
    list: oc.output(z.array(extensionStatusSchema)),
    enable: oc.input(z.object({ id: z.string() })).output(extensionStatusSchema),
    disable: oc.input(z.object({ id: z.string() })).output(extensionStatusSchema),
  },
  events: {
    subscribe: oc.input(z.object({ since: z.number().int().nonnegative().default(0) }))
      .output(eventIterator(gatewayEventSchema)),
  },
};
