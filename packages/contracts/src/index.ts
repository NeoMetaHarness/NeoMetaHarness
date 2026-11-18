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
  assignments: z.array(z.object({ engine: z.string(), targetId: z.string() })),
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
  stop: oc.input(z.object({ threadId: z.string().min(1), runId: z.string().optional() }))
    .output(z.object({ outcome: z.enum(['killed', 'released', 'releasing', 'shared']), sharedWithThreadIds: z.array(z.string()) })),
  diff: oc.input(z.object({
    threadId: z.string().min(1), fromTurnCount: z.number().int().nonnegative(),
    toTurnCount: z.number().int().nonnegative(), ignoreWhitespace: z.boolean().optional(),
  })).output(z.object({ threadId: z.string(), fromTurnCount: z.number(), toTurnCount: z.number(), diff: z.string() })),
  threads: {
    list: oc.output(z.object({
      projects: z.array(z.object({
        id: z.string(), title: z.string(), workspaceRoot: z.string(),
        defaultModelSelection: z.object({ instanceId: z.string(), model: z.string() }).nullable().optional(),
      })),
      threads: z.array(z.object({
        id: z.string(), projectId: z.string(), title: z.string(), status: z.string(),
        activeRunId: z.string().nullable(), itemCount: z.number(),
        pendingRuntimeRequest: z.object({ id: z.string(), kind: z.string() }).nullable(),
      })),
    })),
  },
};

export const dshEventSchema = t3EventSchema;
export type DshEvent = z.infer<typeof dshEventSchema>;
export const dshContract = {
  create: oc.input(z.object({ workspaceId: z.string().min(1), cwd: z.string().min(1), computerId: z.string().min(1).optional(),
    role: z.enum(['default', 'fast', 'reasoning', 'coding', 'eval']).optional(), profile: z.string().min(1).optional() }))
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
    list: oc.input(z.object({ profile: z.string().min(1).optional() }).optional())
      .output(z.array(z.record(z.string(), z.unknown()))),
    create: oc.input(z.object({ prompt: z.string().min(1), schedule: z.string().min(1),
      profile: z.string().min(1).optional(), name: z.string().optional() }))
      .output(z.object({ id: z.string() }).passthrough()),
    update: oc.input(z.object({ id: z.string().min(1), profile: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(), schedule: z.string().min(1).optional(), name: z.string().optional() }))
      .output(z.record(z.string(), z.unknown())),
    pause: oc.input(z.object({ id: z.string().min(1), profile: z.string().min(1).optional(), paused: z.boolean() }))
      .output(z.record(z.string(), z.unknown())),
    trigger: oc.input(z.object({ id: z.string().min(1), profile: z.string().min(1).optional() }))
      .output(z.record(z.string(), z.unknown())),
    history: oc.input(z.object({ id: z.string().min(1), profile: z.string().min(1).optional() }))
      .output(z.object({ runs: z.array(z.record(z.string(), z.unknown())), limit: z.number() })),
    delete: oc.input(z.object({ id: z.string().min(1), profile: z.string().min(1).optional() })).output(z.unknown()),
  },
  kanban: {
    boards: oc.output(z.object({ boards: z.array(z.record(z.string(), z.unknown())), current: z.string() })),
    createBoard: oc.input(z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), name: z.string().optional() }))
      .output(z.record(z.string(), z.unknown())),
    board: oc.input(z.object({ workspace: z.string().min(1) }))
      .output(z.object({ columns: z.array(z.object({ name: z.string(), tasks: z.array(z.record(z.string(), z.unknown())) })),
        assignees: z.array(z.string()), latest_event_id: z.number(), now: z.number() }).passthrough()),
    create: oc.input(z.object({ workspace: z.string().min(1), title: z.string().min(1),
      body: z.string().optional(), assignee: z.string().min(1) }))
      .output(z.object({ task: z.record(z.string(), z.unknown()).nullable() }).passthrough()),
    assign: oc.input(z.object({ workspace: z.string().min(1), id: z.string().min(1), assignee: z.string().min(1) }))
      .output(z.object({ task: z.record(z.string(), z.unknown()) })),
    task: oc.input(z.object({ workspace: z.string().min(1), id: z.string().min(1) }))
      .output(z.object({ task: z.record(z.string(), z.unknown()), events: z.array(z.unknown()), runs: z.array(z.unknown()) }).passthrough()),
    dispatch: oc.input(z.object({ workspace: z.string().min(1) }))
      .output(z.record(z.string(), z.unknown())),
  },
};

export const memoryEntrySchema = z.object({
  id: z.string(), workspace: z.string(), subject: z.enum(['user', 'bot']),
  subject_id: z.string(), text: z.string(), source: z.string(), provenance: z.string(),
  trust: z.enum(['untrusted', 'observed', 'confirmed']),
  created_at: z.number().int(), updated_at: z.number().int(),
});
const memoryWorkspace = z.string().min(1).max(100);
const memoryText = z.string().trim().min(1).max(16000);
export const memoryContract = {
  list: oc.input(z.object({ workspace: memoryWorkspace.default('default'), subjectId: z.string().max(100).optional(), query: z.string().max(500).default('') }))
    .output(z.array(memoryEntrySchema)),
  add: oc.input(z.object({
    workspace: memoryWorkspace.default('default'), subject: z.enum(['bot', 'user']),
    subjectId: z.string().min(1).max(100).default('global'), text: memoryText,
    source: z.string().min(1).max(200).default('manual'),
    provenance: z.string().max(1000).default('Neo Memory UI'),
    trust: z.enum(['untrusted', 'observed', 'confirmed']).default('confirmed'),
  })).output(memoryEntrySchema),
  update: oc.input(z.object({ id: z.string().uuid(), text: memoryText.optional(),
    trust: z.enum(['untrusted', 'observed', 'confirmed']).optional(),
    provenance: z.string().max(1000).optional(), source: z.string().max(200).optional(),
  })).output(memoryEntrySchema.nullable()),
  delete: oc.input(z.object({ id: z.string().uuid() })).output(z.object({ deleted: z.boolean() })),
  export: oc.input(z.object({ workspace: memoryWorkspace.default('default') })).output(z.object({
    'SOUL.md': z.string(), 'USER.md': z.string(), 'MEMORY.md': z.string(),
  })),
};

export const honchoContract = {
  status: oc.input(z.object({ workspace: memoryWorkspace.default('default') }))
    .output(z.enum(['ok', 'degraded', 'off'])),
  list: oc.input(z.object({ workspace: memoryWorkspace.default('default'),
    subjectId: z.string().max(100).optional(), query: z.string().max(500).default('') }))
    .output(z.array(memoryEntrySchema)),
};

const skillName = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const skillId = z.string().regex(/^[a-z][a-z0-9_-]{0,79}\/[a-z][a-z0-9_-]{0,79}$/);
const skillInput = z.union([skillName, skillId]);
const skillTrust = z.enum(['untrusted', 'observed', 'confirmed']);
const skillAutonomy = z.enum(['suggest', 'auto-low', 'auto']);
const skillEval = z.object({
  status: z.enum(['unevaluated', 'passed', 'failed', 'overridden']), version: z.number().int().positive(),
  checkedAt: z.number().optional(), error: z.string().optional(),
  checks: z.array(z.object({ prompt: z.string(), passed: z.boolean(), missing: z.array(z.string()) })).optional(),
  overrideBy: z.string().optional(), overrideReason: z.string().optional(),
});
export const registrySkillSchema = z.object({
  name: skillId, version: z.number().int().positive(), trust: skillTrust,
  sourceProfile: z.string(), sourcePath: z.string(), updatedAt: z.number().int(),
  checks: z.array(z.object({ prompt: z.string(), expected: z.array(z.string()) })).optional(),
  autonomy: skillAutonomy.optional(),
  evaluation: skillEval.optional(),
});
export type RegistrySkill = z.infer<typeof registrySkillSchema>;
const skillTarget = z.object({ name: skillId, engine: z.enum(['hermes', 'dsh']), targetId: z.string().min(1) });
export const skillsRegistryContract = {
  list: oc.output(z.array(registrySkillSchema)),
  get: oc.input(z.object({ name: skillId })).output(z.object({ metadata: registrySkillSchema, content: z.string() })),
  import: oc.input(z.object({
    name: skillInput, content: z.string().min(1).max(200000), sourceProfile: skillName,
    sourcePath: z.string(), trust: skillTrust.optional(),
  })).output(registrySkillSchema),
  sync: oc.input(z.object({ profile: skillName })).output(z.array(registrySkillSchema)),
  versions: oc.input(z.object({ name: skillId })).output(z.array(z.object({
    version: z.number().int().positive(), hash: z.string(), metadata: registrySkillSchema,
  }))),
  diff: oc.input(z.object({ name: skillId, from: z.number().int().positive(), to: z.number().int().positive() }))
    .output(z.object({ diff: z.string() })),
  rollback: oc.input(z.object({ name: skillId, version: z.number().int().positive() })).output(registrySkillSchema),
  assign: oc.input(skillTarget.extend({ assigned: z.boolean() })).output(z.object({ assigned: z.boolean() })),
  assignments: oc.output(z.array(skillTarget)),
  evaluate: oc.input(z.object({ name: skillId })).output(skillEval),
  override: oc.input(z.object({ name: skillId, reason: z.string().trim().min(1).max(1000) })).output(skillEval),
  ceiling: {
    get: oc.input(skillTarget.omit({ name: true })).output(z.object({ ceiling: skillAutonomy })),
    set: oc.input(skillTarget.omit({ name: true }).extend({ ceiling: skillAutonomy }))
      .output(z.object({ ceiling: skillAutonomy })),
  },
};

const modelProviderId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const modelProfile = z.string().regex(/^(?:default|[a-z][a-z0-9_-]{0,47})$/);
const modelRole = z.enum(['default', 'fast', 'reasoning', 'coding', 'eval']);
const modelSelection = z.object({ providerId: modelProviderId, model: z.string().trim().min(1) });
const modelProvider = z.object({
  id: modelProviderId, kind: z.literal('openai-compatible'), name: z.string(),
  baseUrl: z.string().url(), hasKey: z.boolean(),
});
const modelRoles = z.object({
  default: modelSelection.optional(), fast: modelSelection.optional(),
  reasoning: modelSelection.optional(), coding: modelSelection.optional(), eval: modelSelection.optional(),
});
export type ModelProviderRecord = z.infer<typeof modelProvider>;
export type ModelSelectionRecord = z.infer<typeof modelSelection>;
export type ModelRolesRecord = z.infer<typeof modelRoles>;
export type ModelRoleName = z.infer<typeof modelRole>;
export const modelsContract = {
  providers: {
    list: oc.output(z.array(modelProvider)),
    put: oc.input(z.object({
      id: modelProviderId, kind: z.literal('openai-compatible'), name: z.string().optional(),
      baseUrl: z.string().url(), apiKey: z.string().optional(),
    })).output(modelProvider),
    delete: oc.input(z.object({ id: modelProviderId })).output(z.object({ deleted: z.boolean() })),
    test: oc.input(z.object({ id: modelProviderId }))
      .output(z.object({ ok: z.boolean(), models: z.number().int(), status: z.number().int() })),
  },
  roles: {
    get: oc.output(modelRoles),
    set: oc.input(modelSelection.extend({ role: modelRole }))
      .output(z.object({ role: modelRole, selection: modelSelection })),
  },
  override: {
    get: oc.input(z.object({ profile: modelProfile }))
      .output(z.object({ profile: modelProfile, selection: modelSelection.nullable() })),
    set: oc.input(z.object({ profile: modelProfile, providerId: modelProviderId.optional(), model: z.string().trim().min(1).optional() }))
      .output(z.object({ profile: modelProfile, selection: modelSelection.nullable() })),
  },
};

export const channelsPlatformSchema = z.object({
  id: z.string(), name: z.string(), description: z.string().optional(),
  enabled: z.boolean(), configured: z.boolean(), gatewayRunning: z.boolean(),
  error: z.string().optional(),
});
export const channelsContract = {
  list: oc.input(z.object({ profile: z.string().min(1) }))
    .output(z.object({ platforms: z.array(channelsPlatformSchema) })),
  connect: oc.input(z.object({ profile: z.string().min(1), platform: z.literal('telegram'), token: z.string().min(1).max(4096) }))
    .output(z.object({ connected: z.boolean() })),
  disconnect: oc.input(z.object({ profile: z.string().min(1), platform: z.literal('telegram') }))
    .output(z.object({ disconnected: z.boolean() })),
  status: oc.input(z.object({ profile: z.string().min(1) }))
    .output(z.object({ platforms: z.array(channelsPlatformSchema) })),
};

const baseNeoContract = {
  x: { 'engine-t3': t3Contract, 'engine-hermes': hermesContract, 'engine-dsh': dshContract, 'memory-local': memoryContract, 'memory-honcho': honchoContract, 'skills-registry': skillsRegistryContract, models: modelsContract, channels: channelsContract },
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
    state: oc.output(z.object({ engaged: z.boolean() })),
    capture: oc.input(z.object({ id: z.string().min(1) })).output(z.object({
      png: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
    })),
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

export const inboxReportSchema = z.object({
  status: z.enum(['ready', 'question', 'blocked', 'failed']),
  summary: z.string(),
  question: z.string().optional(),
  options: z.array(z.string()).default([]),
  changes: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});
export const inboxItemSchema = z.object({
  id: z.string(), text: z.string(), botId: z.string(),
  source: z.enum(['neo/app', 'neo/cron', 'neo/channel']).optional(),
  requesterRole: z.enum(['viewer', 'member', 'admin', 'owner']).optional(),
  mode: z.enum(['observe', 'act']),
  status: z.enum(['suggestion', 'running', 'ready', 'question', 'blocked', 'failed']),
  ticketId: z.string().optional(), report: inboxReportSchema.optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
export const inboxEventSchema = z.object({ seq: z.number().int(), item: inboxItemSchema });
export type InboxItem = z.infer<typeof inboxItemSchema>;
export type InboxEvent = z.infer<typeof inboxEventSchema>;
export const inboxContract = {
  ask: oc.input(z.object({ text: z.string().min(1), botId: z.string().min(1),
    mode: z.enum(['observe', 'act']).default('observe') })).output(inboxItemSchema),
  list: oc.output(z.array(inboxItemSchema)),
  accept: oc.input(z.object({ id: z.string().min(1) })).output(inboxItemSchema),
  events: oc.input(z.object({ since: z.number().int().nonnegative().default(0) }))
    .output(eventIterator(inboxEventSchema)),
  cron: {
    create: oc.input(z.object({ text: z.string().min(1), botId: z.string().min(1),
      schedule: z.string().min(1), mode: z.enum(['observe', 'act']).default('observe') }))
      .output(z.object({ id: z.string(), text: z.string(), botId: z.string(),
      schedule: z.string(), mode: z.enum(['observe', 'act']),
      requesterRole: z.enum(['member', 'admin', 'owner']).optional() })),
    list: oc.output(z.array(z.object({ id: z.string(), text: z.string(), botId: z.string(),
      schedule: z.string(), mode: z.enum(['observe', 'act']),
      requesterRole: z.enum(['member', 'admin', 'owner']).optional() }))),
    delete: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ deleted: z.boolean() })),
    fire: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ ok: z.boolean() })),
  },
  channel: {
    emit: oc.input(z.object({ id: z.string().min(1), channelId: z.string().min(1),
      botId: z.string().min(1), senderId: z.string().min(1),
      memberRole: z.enum(['viewer', 'member', 'admin', 'owner']),
      text: z.string(), mode: z.enum(['observe', 'act']).optional() }))
      .output(z.object({ ok: z.boolean() })),
    replies: oc.output(z.array(z.object({ channelId: z.string(), inReplyTo: z.string(), text: z.string() }))),
  },
};

export const neoContract = { ...baseNeoContract, agents: agentsContract, inbox: inboxContract };
