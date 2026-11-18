import { oc, eventIterator } from '@orpc/contract';
import { z } from 'zod';

export const extensionStatusSchema = z.object({
  id: z.string(),
  desired: z.boolean(),
  status: z.enum(['running', 'disabled', 'degraded']),
  reason: z.string().optional(),
  health: z.object({ ok: z.boolean(), pid: z.number().optional() }).optional(),
});

export const computerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capture') }),
  z.object({ action: z.literal('click'), x: z.number().finite(), y: z.number().finite() }),
  z.object({ action: z.literal('type'), text: z.string().max(10000) }),
  z.object({ action: z.literal('key'), keys: z.string().max(256) }),
  z.object({ action: z.literal('scroll'), direction: z.string().max(24), amount: z.number().finite() }),
]);

const computerInfoSchema = z.object({
  id: z.string(), providerId: z.string(),
  capabilities: z.object({
    screen: z.boolean(), input: z.boolean(), browserCdp: z.boolean(),
    shell: z.boolean(), files: z.boolean(), snapshot: z.boolean(),
    gpu: z.boolean().optional(),
  }),
  holder: z.enum(['agent', 'human']),
});

export const gatewayEventSchema = z.discriminatedUnion('type', [
  z.object({ seq: z.number().int(), extensionId: z.string(),
    status: z.enum(['running', 'disabled', 'degraded']), type: z.literal('extension.state') }),
  z.object({ seq: z.number().int(), type: z.literal('computer.acting'),
    computerId: z.string(), engine: z.string(), active: z.boolean(),
    action: z.enum(['click', 'type', 'capture', 'key', 'scroll']) }),
  z.object({ seq: z.number().int(), type: z.literal('computer.lease'),
    computerId: z.string(), holder: z.enum(['agent', 'human']) }),
  z.object({ seq: z.number().int(), type: z.literal('computer.kill'), engaged: z.boolean() }),
]);

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

export const dshEventSchema = t3EventSchema;
export type DshEvent = z.infer<typeof dshEventSchema>;
export const dshContract = {
  create: oc.input(z.object({ workspaceId: z.string().min(1), cwd: z.string().min(1), computerId: z.string().min(1).optional() }))
    .output(z.object({ sessionId: z.string(), pid: z.number().int().positive() })),
  prompt: oc.input(z.object({ sessionId: z.string(), text: z.string().min(1) }))
    .output(z.object({ messageId: z.string() })),
  events: oc.input(z.object({ sessionId: z.string().min(1) }))
    .output(eventIterator(dshEventSchema)),
  wait: oc.input(z.object({ sessionId: z.string().min(1) }))
    .output(z.object({ status: z.literal('settled') })),
  cancel: oc.input(z.object({ sessionId: z.string().min(1) }))
    .output(z.object({ cancelled: z.boolean() })),
  shutdown: oc.input(z.object({ sessionId: z.string().min(1) }))
    .output(z.object({ stopped: z.boolean() })),
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
export const hermesEventSchema = t3EventSchema;
export type HermesEvent = z.infer<typeof hermesEventSchema>;

export const hermesContract = {
  skills: {
    list: oc.input(z.object({ profile: z.string().min(1) })).output(z.array(z.object({
      name: z.string(), provenance: z.string().optional(), usage: z.number().optional(),
    }).passthrough())),
    hub: oc.input(z.object({ profile: z.string().min(1) })).output(z.object({
      skills: z.array(z.object({ name: z.string(), installed: z.boolean().optional() }).passthrough()),
    }).passthrough()),
    curator: oc.input(z.object({ profile: z.string().min(1) })).output(z.object({
      enabled: z.boolean(), paused: z.boolean(),
    }).passthrough()),
    pause: oc.input(z.object({ profile: z.string().min(1), paused: z.boolean() }))
      .output(z.object({ ok: z.boolean(), paused: z.boolean() })),
    run: oc.input(z.object({ profile: z.string().min(1) }))
      .output(z.object({ ok: z.boolean(), pid: z.number(), name: z.string() })),
    graph: oc.input(z.object({ profile: z.string().min(1) })).output(z.object({
      nodes: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string() }).passthrough()),
      edges: z.array(z.object({ source: z.string(), target: z.string() }).passthrough()),
    }).passthrough()),
    learn: oc.input(z.object({ profile: z.string().min(1), description: z.string().min(1) }))
      .output(z.object({ run_id: z.string() })),
  },
  profiles: {
    list: oc.output(z.object({ profiles: z.array(z.object({ name: z.string(), path: z.string() }).passthrough()) })),
    create: oc.input(z.object({ name: z.string().min(1) })).output(z.object({
      ok: z.boolean(), name: z.string(), path: z.string(),
    }).passthrough()),
    delete: oc.input(z.object({ name: z.string().min(1) })).output(z.unknown()),
  },
  runs: {
    start: oc.input(z.object({ profile: z.string().min(1), input: z.string().min(1) }))
      .output(z.object({ run_id: z.string() })),
    events: oc.input(z.object({ profile: z.string().min(1), runId: z.string().min(1) }))
      .output(eventIterator(hermesEventSchema)),
    approve: oc.input(z.object({ profile: z.string().min(1), runId: z.string().min(1),
      choice: z.enum(['once', 'session', 'deny']) })).output(z.object({ ok: z.boolean() })),
    stop: oc.input(z.object({ profile: z.string().min(1), runId: z.string().min(1) }))
      .output(z.object({ status: z.string() })),
  },
  cron: {
    list: oc.output(z.array(z.record(z.string(), z.unknown()))),
    create: oc.input(z.object({ prompt: z.string().min(1), schedule: z.string().min(1) }))
      .output(z.object({ id: z.string() }).passthrough()),
    delete: oc.input(z.object({ id: z.string().min(1) })).output(z.unknown()),
  },
};

const baseNeoContract = {
  x: { 'engine-t3': t3Contract, 'engine-hermes': hermesContract, 'engine-dsh': dshContract },
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
  computers: {
    list: oc.output(z.array(computerInfoSchema)),
    attach: oc.input(z.object({ providerId: z.string().min(1), target: z.string().min(1) }))
      .output(computerInfoSchema),
    release: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ released: z.boolean() })),
    lease: oc.input(z.object({ id: z.string().min(1), holder: z.enum(['agent', 'human']) }))
      .output(computerInfoSchema),
    assign: oc.input(z.object({
      engine: z.enum(['hermes', 'dsh']), targetId: z.string().min(1), computerId: z.string().min(1),
    })).output(z.object({ engine: z.string(), targetId: z.string(), computerId: z.string() })),
    kill: oc.input(z.object({ engaged: z.boolean() })).output(z.object({ engaged: z.boolean() })),
  },
  events: {
    subscribe: oc.input(z.object({ since: z.number().int().nonnegative().default(0) }))
      .output(eventIterator(gatewayEventSchema)),
  },
};
export const agentBotSchema = z.object({
  id: z.string(), name: z.string(), created_at: z.number(),
});
export const agentTurnSchema = z.object({
  id: z.string(), bot_id: z.string(), room_id: z.string().nullable(),
  source: z.enum(['user', 'room', 'bot', 'routine']),
  input: z.string(), status: z.enum(['queued', 'running', 'awaiting_approval', 'completed', 'denied', 'stopped', 'failed', 'interrupted']),
  created_at: z.number(), updated_at: z.number(),
});
export const agentRoomSchema = z.object({ id: z.string(), name: z.string(), created_at: z.number() });
export const agentRoomMessageSchema = z.object({
  id: z.string(), room_id: z.string(), author_id: z.string(), body: z.string(), created_at: z.number(),
});
export const agentTaskSchema = z.object({
  id: z.string(), bot_id: z.string(), title: z.string(), status: z.enum(['todo', 'working', 'done']),
  note: z.string(), created_at: z.number(), updated_at: z.number(),
});
export const agentRoutineSchema = z.object({
  id: z.string(), bot_id: z.string(), name: z.string(), prompt: z.string(), schedule: z.string(),
  timezone: z.string(), enabled: z.number(), last_run_at: z.number().nullable(), created_at: z.number(),
});
const agentId = z.string().min(1);
const agentSend = z.object({ botId: agentId, text: z.string().min(1) });
export const agentsContract = {
  bots: {
    list: oc.output(z.array(agentBotSchema)),
    create: oc.input(z.object({ name: z.string().min(1) })).output(agentBotSchema),
    update: oc.input(z.object({ id: agentId, name: z.string().min(1) })).output(agentBotSchema.nullable()),
    delete: oc.input(z.object({ id: agentId })).output(z.object({ deleted: z.boolean() })),
  },
  turns: {
    send: oc.input(agentSend).output(z.object({ turnId: z.string() })),
    events: oc.input(z.object({ turnId: agentId, since: z.number().int().nonnegative().default(0) }))
      .output(eventIterator(t3EventSchema)),
    stop: oc.input(z.object({ turnId: agentId })).output(z.object({ stopped: z.boolean() })),
    list: oc.input(z.object({ botId: agentId })).output(z.array(agentTurnSchema)),
  },
  approvals: {
    list: oc.input(z.object({ turnId: agentId })).output(z.array(z.object({
      id: z.string(), turn_id: z.string(), request_id: z.string(), tool: z.string(), detail: z.string(),
      status: z.enum(['pending', 'approved', 'denied', 'interrupted']),
      created_at: z.number(), resolved_at: z.number().nullable(),
    }))),
    resolve: oc.input(z.object({ id: agentId, decision: z.enum(['allow', 'deny']) }))
      .output(z.object({ resolved: z.boolean() })),
  },
  rooms: {
    list: oc.output(z.array(agentRoomSchema)),
    create: oc.input(z.object({ name: z.string().min(1), memberIds: z.array(agentId) })).output(agentRoomSchema),
    post: oc.input(z.object({ roomId: agentId, text: z.string().min(1), authorId: z.string().default('user') }))
      .output(z.object({ turnIds: z.array(z.string()) })),
    events: oc.input(z.object({ roomId: agentId, after: agentId.optional() }))
      .output(eventIterator(agentRoomMessageSchema)),
  },
  tasks: {
    list: oc.input(z.object({ botId: agentId })).output(z.array(agentTaskSchema)),
    create: oc.input(z.object({ botId: agentId, title: z.string().min(1) })).output(agentTaskSchema),
    update: oc.input(z.object({ id: agentId, status: z.enum(['todo', 'working', 'done']), note: z.string().default('') }))
      .output(z.object({ updated: z.boolean() })),
  },
  routines: {
    list: oc.output(z.array(agentRoutineSchema)),
    create: oc.input(z.object({
      botId: agentId, name: z.string().min(1), prompt: z.string().min(1),
      schedule: z.string().min(1), timezone: z.string().default('UTC'),
    })).output(agentRoutineSchema),
    enable: oc.input(z.object({ id: agentId, enabled: z.boolean() })).output(z.object({ enabled: z.boolean() })),
  },
};

// Agent API is added after all group declarations so its schemas are initialized.
export const neoContract = { ...baseNeoContract, agents: agentsContract };
