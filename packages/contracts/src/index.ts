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

export const t3EventSchema = z.object({
  kind: z.enum(['snapshot', 'synchronized', 'event', 'unknown-event', 'text.delta']),
  sequence: z.number().int().optional(),
  type: z.string().optional(),
  payload: z.unknown().optional(),
  textDelta: z.string().optional(),
  messageId: z.string().optional(),
  coalescedCount: z.number().int().positive().optional(),
});
export type T3Event = z.infer<typeof t3EventSchema>;

export const t3Contract = {
  create: oc.input(z.object({
    threadId: z.string().min(1), projectId: z.string().min(1), title: z.string(),
    providerId: z.string().min(1), model: z.string().min(1),
  })).output(z.object({ sequence: z.number().int() })),
  send: oc.input(z.object({ threadId: z.string().min(1), text: z.string(), messageId: z.string().optional() }))
    .output(z.object({ sequence: z.number().int() })),
  events: oc.input(z.object({ threadId: z.string().min(1) })).output(eventIterator(t3EventSchema)),
  approval: oc.input(z.object({
    threadId: z.string().min(1), requestId: z.string().min(1), decision: z.enum(['approve', 'decline']),
  })).output(z.object({ sequence: z.number().int() })),
  settle: oc.input(z.object({ threadId: z.string().min(1) })).output(z.object({ sequence: z.number().int() })),
};

export const vaultScopeSchema = z.object({
  kind: z.enum(['workspace', 'bot', 'engine']),
  workspaceId: z.string().min(1),
  subjectId: z.string().min(1).optional(),
}).refine((scope) => scope.kind === 'workspace' ? scope.subjectId === undefined : !!scope.subjectId, {
  message: 'Scope subjectId required for bot/engine and forbidden for workspace',
});

export const vaultMetadataSchema = z.object({
  scope: vaultScopeSchema,
  name: z.string(),
  version: z.number().int().positive(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const vaultNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const vaultSelectorSchema = z.object({ scope: vaultScopeSchema, name: vaultNameSchema });
const vaultWriteSchema = vaultSelectorSchema.extend({ value: z.string().min(1) });
export type VaultOperation = 'list' | 'put' | 'rotate' | 'delete';
export const neoContract = {
  x: { 'engine-t3': t3Contract },
  extensions: {
    list: oc.output(z.array(extensionStatusSchema)),
    enable: oc.input(z.object({ id: z.string() })).output(extensionStatusSchema),
    disable: oc.input(z.object({ id: z.string() })).output(extensionStatusSchema),
  },
  vault: {
    list: oc.input(z.object({ scope: vaultScopeSchema })).output(z.array(vaultMetadataSchema)),
    put: oc.input(vaultWriteSchema).output(vaultMetadataSchema),
    rotate: oc.input(vaultWriteSchema).output(vaultMetadataSchema),
    delete: oc.input(vaultSelectorSchema).output(z.object({ deleted: z.boolean() })),
  },
  events: {
    subscribe: oc.input(z.object({ since: z.number().int().nonnegative().default(0) }))
      .output(eventIterator(gatewayEventSchema)),
  },
};
