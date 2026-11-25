import { oc, eventIterator } from '@orpc/contract';
import { z } from 'zod';
import { a2uiContract } from './a2ui.js';
export type { A2uiActionInput, A2uiActionResult } from './a2ui.js';

export const extensionStatusSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  desired: z.boolean(),
  status: z.enum(['running', 'disabled', 'degraded']),
  reason: z.string().optional(),
  health: z.object({ ok: z.boolean(), pid: z.number().optional(), reason: z.string().optional() }).optional(),
  routes: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  settingsVisible: z.boolean().optional(),
});

export const computerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capture') }),
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('navigate'), url: z.string().url().max(4096) }),
  z.object({ action: z.literal('click'), x: z.number().finite(), y: z.number().finite() }),
  z.object({ action: z.literal('move'), x: z.number().finite(), y: z.number().finite() }),
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
  cleanupPending: z.boolean().optional(),
  assignments: z.array(z.object({ engine: z.string(), targetId: z.string() })),
});

export const gatewayEventSchema = z.discriminatedUnion('type', [
  z.object({ seq: z.number().int(), extensionId: z.string(),
    status: z.enum(['running', 'disabled', 'degraded']), type: z.literal('extension.state') }),
  z.object({ seq: z.number().int(), extensionId: z.string(), type: z.literal('extension.upgrade'),
    previousVersion: z.string(), version: z.string() }),
  z.object({ seq: z.number().int(), type: z.literal('computer.acting'),
    computerId: z.string(), engine: z.string(), active: z.boolean(),
    action: z.enum(['click', 'move', 'type', 'capture', 'key', 'scroll', 'navigate', 'status']) }),
  z.object({ seq: z.number().int(), type: z.literal('computer.lease'),
    computerId: z.string(), holder: z.enum(['agent', 'human']) }),
  z.object({ seq: z.number().int(), type: z.literal('computer.kill'), engaged: z.boolean() }),
  z.object({ seq: z.number().int(), type: z.literal('computer.action'), computerId: z.string(),
    providerId: z.string(), engine: z.string(), targetId: z.string(),
    action: z.enum(['click', 'move', 'type', 'capture', 'key', 'scroll', 'navigate', 'status']),
    outcome: z.enum(['allowed', 'denied', 'failed']) }),
  // workspaceId (P1-13): whose settings changed; server-mode subscribers only receive their own workspace's.
  z.object({ seq: z.number().int(), type: z.literal('settings.change'), extension: z.string(), values: z.record(z.string(), z.unknown()),
    workspaceId: z.string().optional() }),
]);

export type GatewayEvent = z.infer<typeof gatewayEventSchema>;
export type ExtensionStatus = z.infer<typeof extensionStatusSchema>;

export const t3EventSchema = z.object({
  kind: z.enum(['snapshot', 'synchronized', 'event', 'unknown-event', 'text.delta']),
  sequence: z.number().int().optional(),
  type: z.string().optional(),
  payload: z.unknown().optional(),
  textDelta: z.string().optional(),
  fullText: z.boolean().optional(),
  messageId: z.string().optional(),
  coalescedCount: z.number().int().positive().optional(),
});
export type T3Event = z.infer<typeof t3EventSchema>;

export { codingWorkflowContract } from './coding-workflow.js';
import { codingWorkflowContract } from './coding-workflow.js';

export const t3InstallStatusSchema = z.object({
  state: z.enum(['not_installed', 'installing', 'ready', 'failed']),
  phase: z.enum(['download', 'verify', 'extract', 'starting']).optional(),
  progress: z.number().min(0).max(1).optional(),
  message: z.string(),
  error: z.string().optional(),
  connected: z.boolean().optional(),
  external: z.boolean().optional(),
});
export type T3InstallStatus = z.infer<typeof t3InstallStatusSchema>;

const t3SubscriptionFlowSchema = z.object({
  instanceId: z.string(), phase: z.enum(['idle', 'starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled']),
  flowId: z.string().nullable(), expiresAt: z.string().nullable(), verificationUrl: z.string().nullable(), userCode: z.string().nullable(),
});
const t3SubscriptionInput = z.object({ instanceId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/) });
export const t3Contract = {
  install: {
    status: oc.output(t3InstallStatusSchema),
    start: oc.output(t3InstallStatusSchema),
  },
  runtime: { start: oc.output(t3InstallStatusSchema) },
  subscription: {
    status: oc.output(z.object({ providers: z.array(z.object({
      instanceId: z.string(), provider: z.enum(['codex', 'claude']), status: z.enum(['authenticated', 'unauthenticated', 'unknown']),
      signedIn: z.boolean(), canStart: z.boolean(), accountLabel: z.string().nullable(), guidance: z.string(),
    })) })),
    start: oc.input(t3SubscriptionInput).output(t3SubscriptionFlowSchema),
    poll: oc.input(t3SubscriptionInput).output(t3SubscriptionFlowSchema),
  },
  providers: {
    list: oc.output(z.object({ providers: z.array(z.object({
      id: z.string(), name: z.string(), status: z.string(),
      models: z.array(z.object({ id: z.string(), name: z.string(), isDefault: z.boolean() })),
    })) })),
  },
  create: oc.input(z.object({
    threadId: z.string().min(1), projectId: z.string().min(1), title: z.string(),
    providerId: z.string().min(1), model: z.string().min(1), interactive: z.boolean().optional(),
  })).output(z.object({ sequence: z.number().int(), threadId: z.string().optional() })),
  send: oc.input(z.object({ threadId: z.string().min(1), text: z.string(), messageId: z.string().optional(), interactive: z.boolean().optional() }))
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
  rollback: oc.input(z.object({
    threadId: z.string().min(1), scopeId: z.string().min(1), checkpointId: z.string().min(1),
  })).output(z.object({ sequence: z.number().int() })),
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
    role: z.enum(['default', 'fast', 'reasoning', 'coding', 'eval']).optional(), profile: z.string().min(1).optional(),
    plugins: z.object({ memory: z.boolean().optional(), soul: z.boolean().optional(),
      skills: z.boolean().optional(), report: z.boolean().optional() }).optional() }))
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

/** P7-16: installing Hermes on demand (installed apps ship without its source or Python environment). */
export const hermesInstallStatusSchema = z.object({
  state: z.enum(['not_installed', 'installing', 'ready', 'failed']),
  phase: z.enum(['download', 'verify', 'extract', 'python', 'dependencies', 'starting']).optional(),
  progress: z.number().min(0).max(1).optional(),
  message: z.string(),
  error: z.string().optional(),
});
export type HermesInstallStatus = z.infer<typeof hermesInstallStatusSchema>;

/** P7-16: installing the super agent on demand (installed apps ship without the dsh-superagent source). */
export const superagentInstallStatusSchema = z.object({
  state: z.enum(['not_installed', 'installing', 'ready', 'failed']),
  phase: z.enum(['download', 'verify', 'extract', 'build', 'starting']).optional(),
  progress: z.number().min(0).max(1).optional(),
  message: z.string(),
  error: z.string().optional(),
});
export type SuperagentInstallStatus = z.infer<typeof superagentInstallStatusSchema>;
export const superagentContract = {
  install: {
    status: oc.output(superagentInstallStatusSchema),
    start: oc.output(superagentInstallStatusSchema),
  },
};

const hermesSubscriptionProfile = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const hermesSubscriptionSession = z.object({
  profile: hermesSubscriptionProfile,
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
const hermesSubscriptionStatus = z.object({
  sessionId: z.string(),
  status: z.enum(['pending', 'approved', 'expired', 'cancelled', 'denied', 'error']),
  signedIn: z.boolean(),
  accountLabel: z.string().optional(),
});

export const hermesContract = {
  subscription: {
    start: oc.input(z.object({ profile: hermesSubscriptionProfile })).output(z.object({
      sessionId: z.string(), userCode: z.string(), verificationUrl: z.string(),
      expiresIn: z.number().positive(), pollInterval: z.number().positive(),
    })),
    poll: oc.input(hermesSubscriptionSession).output(hermesSubscriptionStatus),
    cancel: oc.input(hermesSubscriptionSession).output(hermesSubscriptionStatus),
  },
  install: {
    status: oc.output(hermesInstallStatusSchema),
    start: oc.output(hermesInstallStatusSchema),
  },
  skills: {
    list: oc.input(z.object({ profile: z.string().min(1) })).output(z.array(z.object({
      name: z.string(), provenance: z.string().optional(), usage: z.number().optional(),
    }).passthrough())),
    hub: oc.input(z.object({ profile: z.string().min(1) })).output(z.object({
      skills: z.array(z.object({ name: z.string(), installed: z.boolean().optional() }).passthrough()),
    }).passthrough()),
    preview: oc.input(z.object({ profile: z.string().min(1), identifier: z.string().min(1).max(500) })).output(z.object({
      name: z.string(), identifier: z.string(), skill_md: z.string(), files: z.array(z.string()),
    }).passthrough()),
    scan: oc.input(z.object({ profile: z.string().min(1), identifier: z.string().min(1).max(500) })).output(z.object({
      policy: z.string(), findings: z.array(z.unknown()),
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
    start: oc.input(z.object({ profile: z.string().min(1), input: z.string().min(1),
      interactive: z.boolean().optional(), conversationId: z.uuid().optional() }))
      .output(z.object({ run_id: z.string(), conversationId: z.uuid().optional() })),
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
    trust: z.enum(['untrusted', 'observed', 'confirmed']).default('observed'),
  })).output(memoryEntrySchema),
  update: oc.input(z.object({ id: z.string().uuid(), text: memoryText.optional(),
    trust: z.enum(['untrusted', 'observed', 'confirmed']).optional(),
    provenance: z.string().max(1000).optional(), source: z.string().max(200).optional(),
  })).output(memoryEntrySchema.nullable()),
  delete: oc.input(z.object({ id: z.string().uuid() })).output(z.object({ deleted: z.boolean() })),
  export: oc.input(z.object({ workspace: memoryWorkspace.default('default') })).output(z.object({
    'SOUL.md': z.string(), 'USER.md': z.string(), 'MEMORY.md': z.string(),
  })),
  /** Standing intents: durable user-stated goals or preferences (L1, source `neo.intent`). */
  intents: {
    list: oc.input(z.object({ workspace: memoryWorkspace.default('default') })).output(z.array(memoryEntrySchema)),
    add: oc.input(z.object({ workspace: memoryWorkspace.default('default'), text: z.string().trim().min(1).max(2000) }))
      .output(memoryEntrySchema),
    update: oc.input(z.object({ workspace: memoryWorkspace.default('default'), id: z.string().uuid(),
      text: z.string().trim().min(1).max(2000) })).output(memoryEntrySchema.nullable()),
    retract: oc.input(z.object({ workspace: memoryWorkspace.default('default'), id: z.string().uuid() }))
      .output(z.object({ retracted: z.boolean() })),
  },
};

/** One consolidation step a dream proposes. Destructive steps delete an L1 entry. */
export const dreamProposalSchema = z.object({
  kind: z.enum(['dedupe', 'retract', 'promote', 'sync-l2', 'sync-l1']),
  target: z.string(), text: z.string(), reason: z.string(), destructive: z.boolean(),
});
export const dreamReportSchema = z.object({
  id: z.string(), workspace: z.string(), createdAt: z.number(),
  /** empty: nothing to change; applied: written under an `act` accept mode or after approval;
   * proposed: waiting in the Inbox; undelivered: no Inbox available; rejected: denied or dismissed. */
  status: z.enum(['empty', 'applied', 'proposed', 'undelivered', 'rejected']),
  acceptMode: z.enum(['observe', 'act-with-approval', 'act']).optional(),
  inboxId: z.string().optional(),
  proposals: z.array(dreamProposalSchema), applied: z.number().int(), skipped: z.number().int(),
  risks: z.array(z.string()), markdown: z.string(),
});
export type DreamProposal = z.infer<typeof dreamProposalSchema>;
export type DreamReport = z.infer<typeof dreamReportSchema>;

export const honchoContract = {
  status: oc.input(z.object({ workspace: memoryWorkspace.default('default') }))
    .output(z.enum(['ok', 'degraded', 'off'])),
  list: oc.input(z.object({ workspace: memoryWorkspace.default('default'),
    subjectId: z.string().max(100).optional(), query: z.string().max(500).default('') }))
    .output(z.array(memoryEntrySchema)),
  dream: {
    run: oc.input(z.object({ workspace: memoryWorkspace.default('default') })).output(dreamReportSchema),
    last: oc.input(z.object({ workspace: memoryWorkspace.default('default') })).output(dreamReportSchema.nullable()),
  },
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
const hubReport = z.object({
  id: z.string().length(64), profile: skillName, identifier: z.string(), name: skillName,
  blocked: z.boolean(), scannedAt: z.number(), approved: z.boolean().optional(),
  approvedBy: z.string().optional(), approvedReason: z.string().optional(),
  files: z.array(z.string()),
  findings: z.array(z.object({ file: z.string(), line: z.number(), category: z.string(), description: z.string() })),
});
export const registrySkillSchema = z.object({
  name: skillId, version: z.number().int().positive(), trust: skillTrust,
  sourceProfile: z.string(), sourcePath: z.string(), updatedAt: z.number().int(),
  checks: z.array(z.object({ prompt: z.string(), expected: z.array(z.string()) })).optional(),
  autonomy: skillAutonomy.optional(),
  evaluation: skillEval.optional(),
  provenance: z.string().optional(),
});
export type RegistrySkill = z.infer<typeof registrySkillSchema>;
const skillTarget = z.object({ name: skillId, engine: z.enum(['hermes', 'dsh', 'superagent']), targetId: z.string().min(1) });
export const metricsSummarySchema = z.object({
  completedTickets: z.number().int().nonnegative().nullable(),
  finishedTickets: z.number().int().nonnegative().nullable(),
  attention: z.object({
    share: z.number().min(0).max(1).nullable(),
    observedWithoutFinalApprovalShare: z.number().min(0).max(1).nullable(),
    withRecordedApproval: z.number().int().nonnegative().nullable(),
    reason: z.string(),
  }),
  learning: z.object({
    promotedPer20: z.number().nonnegative().nullable(),
    rollbackRate: z.number().min(0).max(1).nullable(),
    qualifiedSkills: z.number().int().nonnegative().nullable(),
    reason: z.string(),
  }),
  firstValue: z.object({
    minutes: z.number().nonnegative().nullable(),
    onboardingToFirstReplyMinutes: z.number().nonnegative().nullable(),
    reason: z.string(),
  }),
});
export type MetricsSummary = z.infer<typeof metricsSummarySchema>;
export const metricsContract = { summary: oc.output(metricsSummarySchema) };

export const skillsRegistryContract = {
  list: oc.output(z.array(registrySkillSchema)),
  get: oc.input(z.object({ name: skillId })).output(z.object({ metadata: registrySkillSchema, content: z.string() })),
  import: oc.input(z.object({
    name: skillInput, content: z.string().min(1).max(200000), sourceProfile: skillName,
    sourcePath: z.string().optional(),
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
  checks: {
    set: oc.input(z.object({ name: skillId, checks: z.array(z.object({
      prompt: z.string().trim().min(1).max(4000), expected: z.array(z.string().min(1).max(500)).min(1).max(10),
    })).min(1).max(20) })).output(registrySkillSchema),
  },
  autonomy: {
    set: oc.input(z.object({ name: skillId, autonomy: skillAutonomy })).output(registrySkillSchema),
  },
  evaluate: oc.input(z.object({ name: skillId })).output(skillEval),
  override: oc.input(z.object({ name: skillId, reason: z.string().trim().min(1).max(1000) })).output(skillEval),
  ceiling: {
    get: oc.input(skillTarget.omit({ name: true })).output(z.object({ ceiling: skillAutonomy })),
    set: oc.input(skillTarget.omit({ name: true }).extend({ ceiling: skillAutonomy }))
      .output(z.object({ ceiling: skillAutonomy })),
  },
  hub: {
    scan: oc.input(z.object({ profile: skillName, identifier: z.string().min(1).max(500) })).output(hubReport),
    approve: oc.input(z.object({ id: z.string().length(64), reason: z.string().trim().min(1).max(1000) })).output(hubReport),
    install: oc.input(z.object({ profile: skillName, identifier: z.string().min(1).max(500), reportId: z.string().length(64) }))
      .output(registrySkillSchema),
  },
};

// Provider-neutral voice capability. Extensions provide this as the `neo.voice` service.
export const voiceTranscribeInput = z.object({
  audioBase64: z.string().min(1).max(12_000_000),
  mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i),
  language: z.string().min(2).max(40).optional(),
});
export const voiceTranscribeOutput = z.object({
  text: z.string(), language: z.string().optional(), duration: z.number().nonnegative().optional(),
});
export const voiceSynthesizeInput = z.object({
  text: z.string().min(1).max(15_000),
  voice: z.string().min(1).max(128).optional(), language: z.string().min(2).max(40).optional(),
});
export const voiceSynthesizeOutput = z.object({
  audioBase64: z.string(), mimeType: z.string(),
});
export type VoiceTranscribeInput = z.infer<typeof voiceTranscribeInput>;
export type VoiceTranscribeOutput = z.infer<typeof voiceTranscribeOutput>;
export type VoiceSynthesizeInput = z.infer<typeof voiceSynthesizeInput>;
export type VoiceSynthesizeOutput = z.infer<typeof voiceSynthesizeOutput>;
export interface NeoVoiceService {
  readonly providerId: string;
  transcribe(input: VoiceTranscribeInput, requesterId?: string, workspaceId?: string, signal?: AbortSignal): Promise<VoiceTranscribeOutput>;
  synthesize(input: VoiceSynthesizeInput, requesterId?: string, workspaceId?: string, signal?: AbortSignal): Promise<VoiceSynthesizeOutput>;
}
export const voiceXaiContract = {
  status: oc.output(z.object({ providerId: z.literal('xai'), configured: z.boolean() })),
  transcribe: oc.input(voiceTranscribeInput).output(voiceTranscribeOutput),
  synthesize: oc.input(voiceSynthesizeInput).output(voiceSynthesizeOutput),
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
const modelsConfigContract = {
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
/**
 * The caller's workspace configuration, plus `deployment`: the deployment's own (Hermes profiles and registry
 * evaluation use it; P1-13), which only the deployment owner manages (P1-14).
 */
export const modelsContract = { ...modelsConfigContract, deployment: modelsConfigContract };

const pandaCandidate = modelSelection.extend({ modelId: z.string().trim().min(1).max(256) });
export const pandaSettingsSchema = z.object({
  endpoint: z.string().url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, 'Use an HTTP endpoint without embedded credentials or query parameters'),
  vaultSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
  timeoutMs: z.number().int().min(50).max(10000).default(1500),
  roles: z.object({
    default: z.array(pandaCandidate).max(32).optional(), fast: z.array(pandaCandidate).max(32).optional(),
    reasoning: z.array(pandaCandidate).max(32).optional(), coding: z.array(pandaCandidate).max(32).optional(),
    eval: z.array(pandaCandidate).max(32).optional(),
  }).strict(),
  escalation: z.object({
    enabled: z.boolean(),
    maxAttempts: z.number().int().min(1).max(2),
    maxTotalMs: z.number().int().min(100).max(120000),
  }).strict().optional(),
}).strict();
export type PandaSettings = z.infer<typeof pandaSettingsSchema>;
const pandaSettingsContract = {
  get: oc.output(pandaSettingsSchema.nullable()),
  set: oc.input(pandaSettingsSchema).output(pandaSettingsSchema),
};

// Search is a bot-facing tool supplied by an optional provider extension.
export const xSearchInput = z.object({
  query: z.string().trim().min(1).max(2000),
  allowedHandles: z.array(z.string().regex(/^[a-zA-Z0-9_]{1,15}$/)).max(20).optional(),
  excludedHandles: z.array(z.string().regex(/^[a-zA-Z0-9_]{1,15}$/)).max(20).optional(),
  fromDate: z.string().date().optional(),
  toDate: z.string().date().optional(),
}).refine((value) => !(value.allowedHandles && value.excludedHandles), {
  message: 'Allowed and excluded handles cannot be combined',
});
export const xSearchOutput = z.object({
  text: z.string().max(32000),
  citations: z.array(z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value))).max(32),
  usage: z.object({ postsFetched: z.number().int().nonnegative(), usersFetched: z.number().int().nonnegative() }),
});
export type XSearchInput = z.infer<typeof xSearchInput>;
export type XSearchOutput = z.infer<typeof xSearchOutput>;
export interface NeoSearchService {
  /** Metered calls must carry the authenticated caller's identity; the gateway supplies this for RPCs. */
  search(input: XSearchInput, requester: { userId: string; workspaceId: string }): Promise<XSearchOutput>;
}
export const xSearchContract = {
  status: oc.output(z.object({ providerId: z.literal('xai'), configured: z.boolean() })),
  search: oc.input(xSearchInput).output(xSearchOutput),
};
export const pandaContract = {
  settings: pandaSettingsContract,
  /** The deployment's router settings (P1-13); deployment owner only (P1-14). */
  deployment: { settings: pandaSettingsContract },
  health: oc.output(z.object({ ok: z.boolean(), configured: z.boolean() })),
};

export const channelsPlatformSchema = z.object({
  id: z.string(), name: z.string(), description: z.string().optional(),
  enabled: z.boolean(), configured: z.boolean(), gatewayRunning: z.boolean(),
  error: z.string().optional(),
  /** WhatsApp: a linked device session exists (QR pairing is done in Hermes). */
  paired: z.boolean().optional(),
});
/** WhatsApp sender: a phone number in international form, digits only. */
const channelSender = z.string().regex(/^\d{6,20}$/);
/** Neo role a channel sender acts with in the Inbox; never owner. */
const channelSenderRole = z.enum(['viewer', 'member', 'admin']);
const channelSenders = z.object({ senders: z.array(z.object({ senderId: z.string(), role: channelSenderRole })) });
const whatsappNotify = z.object({ profile: z.string().min(1).max(48), senderId: channelSender });
export const channelsContract = {
  notification: { resolve: oc.input(whatsappNotify.extend({ botId: z.string().min(1) }))
    .output(z.object({ channelId: z.string() })) },
  list: oc.input(z.object({ profile: z.string().min(1) }))
    .output(z.object({ platforms: z.array(channelsPlatformSchema) })),
  connect: oc.input(z.discriminatedUnion('platform', [
    z.object({ profile: z.string().min(1), platform: z.literal('telegram'), token: z.string().min(1).max(4096) }),
    // WhatsApp has no API token (device pairing); Inbox reports are filed for this bot.
    z.object({ profile: z.string().min(1), platform: z.literal('whatsapp'), botId: z.string().min(1).max(200) }),
  ])).output(z.object({ connected: z.boolean() })),
  disconnect: oc.input(z.object({ profile: z.string().min(1), platform: z.enum(['telegram', 'whatsapp']) }))
    .output(z.object({ disconnected: z.boolean() })),
  status: oc.input(z.object({ profile: z.string().min(1) }))
    .output(z.object({ platforms: z.array(channelsPlatformSchema) })),
  senders: oc.input(z.object({ profile: z.string().min(1), platform: z.literal('whatsapp') })).output(channelSenders),
  allow: oc.input(z.object({ profile: z.string().min(1), platform: z.literal('whatsapp'),
    senderId: channelSender, role: channelSenderRole })).output(channelSenders),
  revoke: oc.input(z.object({ profile: z.string().min(1), platform: z.literal('whatsapp'), senderId: channelSender }))
    .output(channelSenders),
  /** Approve a Hermes DM pairing code (8 chars, Hermes' alphabet) and admit that sender with a role. */
  approve: oc.input(z.object({ profile: z.string().min(1), platform: z.literal('whatsapp'),
    code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/), role: channelSenderRole }))
    .output(z.object({ senderId: z.string(), role: channelSenderRole })),
};

const baseNeoContract = {
  system: {
    transferDeploymentOwner: oc.input(z.object({ userId: z.string().min(1) })).output(z.object({ userId: z.string() })),
    restore: oc.input(z.object({ archive: z.string().min(1), dataDir: z.string().min(1),
      passphrase: z.string().min(12), force: z.boolean().default(false) }))
      .output(z.object({ dataDir: z.string(), databaseFile: z.string(), files: z.number().int(), format: z.number().int() })),
    backup: oc.input(z.object({ out: z.string().min(1), passphrase: z.string().min(12) }))
      .output(z.object({ out: z.string(), files: z.number().int(), format: z.number().int() })),
  },
  x: { a2ui: a2uiContract, 'coding-workflow': codingWorkflowContract, 'models-router-panda': pandaContract, 'engine-t3': t3Contract, 'engine-hermes': hermesContract, 'engine-superagent': superagentContract, 'engine-dsh': dshContract, 'memory-local': memoryContract, 'memory-honcho': honchoContract, 'skills-registry': skillsRegistryContract, models: modelsContract, channels: channelsContract, metrics: metricsContract, 'voice-xai': voiceXaiContract, 'x-search': xSearchContract },
  onboarding: {
    get: oc.output(z.object({ completed: z.boolean(), completedAt: z.string().nullable(), ownerName: z.string(), workspaceName: z.string(), mode: z.enum(['desktop', 'server']) })),
    complete: oc.output(z.object({ completed: z.boolean(), completedAt: z.string().nullable(), ownerName: z.string(), workspaceName: z.string(), mode: z.enum(['desktop', 'server']) })),
  },
  extensions: {
    list: oc.output(z.array(extensionStatusSchema)),
    enable: oc.input(z.object({ id: z.string() })).output(extensionStatusSchema),
    disable: oc.input(z.object({ id: z.string() })).output(extensionStatusSchema),
    uninstall: oc.input(z.object({ id: z.string().min(1) })).output(extensionStatusSchema),
    upgrade: oc.input(z.object({ id: z.string().min(1), directory: z.string().min(1), integrity: z.string().regex(/^[a-f0-9]{64}$/i),
      healthTimeoutMs: z.number().int().min(10).max(30000).optional(), drainTimeoutMs: z.number().int().min(10).max(30000).optional(),
    })).output(z.object({ extension: extensionStatusSchema, previousVersion: z.string(), upgraded: z.boolean(), reason: z.string().optional() })),
  },
  settings: {
    get: oc.input(z.object({ extension: z.string().min(1) }))
      .output(z.object({
        extension: z.string(),
        values: z.record(z.string(), z.unknown()),
        schema: z.record(z.string(), z.unknown()).optional(),
      })),
    set: oc.input(z.object({
      extension: z.string().min(1),
      values: z.record(z.string(), z.unknown()),
    }))
      .output(z.object({
        extension: z.string(),
        values: z.record(z.string(), z.unknown()),
        warning: z.string().optional(),
      })),
  },
  vault: {
    list: oc.input(z.object({ scope: vaultScopeSchema })).output(z.array(vaultMetadataSchema)),
    put: oc.input(vaultWriteSchema).output(vaultMetadataSchema),
    rotate: oc.input(vaultWriteSchema).output(vaultMetadataSchema),
    delete: oc.input(vaultSelectorSchema).output(z.object({ deleted: z.boolean() })),
  },
  computers: {
    policy: {
      get: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ allowDestructiveKeys: z.boolean(), navigationOrigins: z.array(z.string()) })),
      set: oc.input(z.object({ id: z.string().min(1), allowDestructiveKeys: z.boolean(), navigationOrigins: z.array(z.string().max(2048)).max(32) }))
        .output(z.object({ allowDestructiveKeys: z.boolean(), navigationOrigins: z.array(z.string()) })),
    },
    list: oc.output(z.array(computerInfoSchema)),
    provision: oc.input(z.object({
      providerId: z.string().min(1),
      spec: z.object({ image: z.string().min(1).max(255).optional(), vncPort: z.number().int().min(1).max(65535).optional(), secretName: z.string().min(1).max(128).optional() }).catchall(z.unknown()),
    })).output(computerInfoSchema),
    attach: oc.input(z.object({ providerId: z.string().min(1), target: z.string().min(1) }))
      .output(computerInfoSchema),
    release: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ released: z.boolean() })),
    terminate: oc.input(z.object({ id: z.string().min(1) })).output(z.object({ terminated: z.boolean() })),
    lease: oc.input(z.object({ id: z.string().min(1), holder: z.enum(['agent', 'human']) }))
      .output(computerInfoSchema),
    assign: oc.input(z.object({
      engine: z.enum(['hermes', 'dsh', 'superagent']), targetId: z.string().min(1), computerId: z.string().min(1),
    })).output(z.object({ engine: z.string(), targetId: z.string(), computerId: z.string() })),
    kill: oc.input(z.object({ engaged: z.boolean() })).output(z.object({ engaged: z.boolean() })),
    state: oc.output(z.object({ engaged: z.boolean() })),
    capture: oc.input(z.object({ id: z.string().min(1) })).output(z.object({
      png: z.string(), width: z.number().int().positive(), height: z.number().int().positive(),
    })),
    local: {
      status: oc.output(z.object({ available: z.boolean(), enabled: z.boolean() })),
      set: oc.input(z.object({ enabled: z.boolean() })).output(z.object({ enabled: z.boolean() })),
    },
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
  status: z.enum(['ready', 'question', 'approval', 'blocked', 'failed']),
  summary: z.string(),
  question: z.string().optional(),
  options: z.array(z.string()).default([]),
  changes: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  postmortem: z.object({
    worked: z.string(), failed: z.string(), reusable: z.boolean(),
    procedure: z.string().optional(), skill: z.string().optional(),
  }).optional(),
  playbook: z.object({ skill: z.string(), provenance: z.string(), tickets: z.array(z.string()) }).optional(),
});
/** Workspace accept mode for inferred Source work (`@neo` comments, failing checks). */
export const acceptModeSchema = z.enum(['observe', 'act-with-approval', 'act']);
export type AcceptMode = z.infer<typeof acceptModeSchema>;
export const inboxEpisodeSchema = z.object({
  goal: z.string(), steps: z.array(z.string()), tools: z.array(z.string()),
  outcome: z.enum(['ready', 'blocked', 'failed']), traceId: z.string(),
  procedure: z.string().optional(),
});
export const appActionSchema = z.object({ provider: z.string().min(1).max(64), accountId: z.string().min(1).max(200),
  action: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), arguments: z.record(z.string(), z.unknown()) });
export const appsContract = {
  toolkits: oc.input(z.object({ provider: z.string().default('composio') })).output(z.array(z.object({ id: z.string(), name: z.string() }))),
  connect: oc.input(z.object({ provider: z.string().default('composio'), toolkit: z.string().min(1).max(200),
    authConfigId: z.string().min(1).max(200) }))
    .output(z.object({ id: z.string(), toolkit: z.string(), redirectUrl: z.string().url() })),
  run: oc.input(appActionSchema).output(z.unknown()),
  grant: oc.input(z.object({ provider: z.string().default('composio'), accountId: z.string().min(1).max(200),
    engine: z.enum(['hermes', 'dsh', 'superagent']), profile: z.string().min(1).max(200), enabled: z.boolean() })).output(z.object({ ok: z.boolean() })),
};
export const appsOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('toolkits'), provider: z.string().default('composio') }),
  z.object({ operation: z.literal('connect'), provider: z.string().default('composio'), toolkit: z.string().min(1).max(200), authConfigId: z.string().min(1).max(200) }).strict(),
  appActionSchema.extend({ operation: z.literal('run') }),
]);
export const inboxItemSchema = z.object({
  id: z.string(), text: z.string(), botId: z.string(),
  /**
   * The workspace the item belongs to (P6-10), set by the Gateway from the caller (asks, schedules) or by the
   * producer (memory dreams). Server-mode deployment owners can additionally see unstamped binding notices,
   * GitHub items, and upstream notices. Unstamped channel conversations remain private.
   */
  workspace: z.string().optional(),
  notification: z.object({ channelId: z.string(), deliveredAt: z.number().optional(), error: z.string().optional() }).optional(),
  source: z.enum(['neo/app', 'neo/cron', 'neo/channel', 'neo/binding', 'neo/upstream', 'neo/github', 'neo/dsh', 'neo/memory', 'neo/apps']).optional(),
  github: z.object({ repo: z.string(), issue: z.number().int().optional(),
    url: z.string(), kind: z.enum(['comment', 'check']), posted: z.boolean().optional() }).optional(),
  upstream: z.object({ name: z.string(), pinned: z.string(), latest: z.string(),
    changelog: z.string().url().nullable() }).optional(),
  /** A memory dream report whose proposals this item accepts or approves. */
  dream: z.object({ id: z.string(), workspace: z.string(), proposals: z.number().int() }).optional(),
  appAction: z.object({ provider: z.string(), accountId: z.string(), action: z.string(), workspaceId: z.string().optional(), ownerUserId: z.string().optional(), arguments: z.record(z.string(), z.unknown()).optional() }).optional(),
  requesterRole: z.enum(['viewer', 'member', 'admin', 'owner']).optional(),
  mode: z.enum(['observe', 'act']),
  status: z.enum(['suggestion', 'running', 'ready', 'question', 'approval', 'blocked', 'failed', 'dismissed']),
  kind: z.enum(['question', 'approval', 'failure', 'suggestion']).optional(),
  /** Workspace accept mode the item was created under (inferred Source work only). */
  acceptMode: acceptModeSchema.optional(),
  /** Destructive work: accepting it needs an admin or owner. */
  destructive: z.boolean().optional(),
  approval: z.object({ destructive: z.boolean(), reason: z.string(),
    decision: z.enum(['approved', 'denied']).optional(),
    ownerApproved: z.boolean().optional(), adminApproved: z.boolean().optional() }).optional(),
  ticketId: z.string().optional(), report: inboxReportSchema.optional(),
  episode: inboxEpisodeSchema.optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
export const inboxEventSchema = z.object({ seq: z.number().int(), item: inboxItemSchema });
export const inboxDecisionSchema = z.object({
  trace_id: z.string(), ticketId: z.string(), workspace: z.string().optional(), source: z.string(), inputsSummary: z.string(),
  candidates: z.array(z.string()), chosenAction: z.string(), modelRole: z.enum(['eval', 'coding']),
  latencyMs: z.number(), outcome: z.string(), model_id: z.string(), success: z.boolean(),
  actual_latency_ms: z.number(), choice: z.object({ model_id: z.string() }),
  ranking: z.array(z.object({ model_id: z.string() })), at: z.number(),
});
export type InboxDecision = z.infer<typeof inboxDecisionSchema>;
export type InboxItem = z.infer<typeof inboxItemSchema>;
export type InboxEvent = z.infer<typeof inboxEventSchema>;
export const inboxContract = {
  ask: oc.input(z.object({ text: z.string().min(1), botId: z.string().min(1),
    mode: z.enum(['observe', 'act']).default('observe'), notify: whatsappNotify.optional() })).output(inboxItemSchema),
  list: oc.output(z.array(inboxItemSchema)),
  decisions: { list: oc.input(z.object({ ticketId: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(100) })).output(z.array(inboxDecisionSchema)) },
  accept: oc.input(z.object({ id: z.string().min(1) })).output(inboxItemSchema),
  dismiss: oc.input(z.object({ id: z.string().min(1), reason: z.string().trim().max(500).optional() }))
    .output(inboxItemSchema),
  acceptMode: {
    get: oc.output(z.object({ mode: acceptModeSchema })),
    set: oc.input(z.object({ mode: acceptModeSchema })).output(z.object({ mode: acceptModeSchema })),
    deployment: {
      get: oc.output(z.object({ mode: acceptModeSchema })),
      set: oc.input(z.object({ mode: acceptModeSchema })).output(z.object({ mode: acceptModeSchema })),
    },
  },
  reply: oc.input(z.object({ id: z.string().min(1), answer: z.string().trim().min(1) })).output(inboxItemSchema),
  approval: { decide: oc.input(z.object({ id: z.string().min(1),
    decision: z.enum(['approve', 'deny']), reason: z.string().trim().min(1) })).output(inboxItemSchema) },
  retry: oc.input(z.object({ id: z.string().min(1) })).output(inboxItemSchema),
  upstream: {
    check: oc.output(z.object({ checked: z.number().int(), drift: z.number().int() })),
    /** The bot that does upstream work: approved bumps and, in the act modes, read-only reviews (P6-8). */
    configure: oc.input(z.object({ botId: z.string().min(1).nullable() })).output(z.object({ ok: z.boolean() })),
    status: oc.output(z.object({ botId: z.string().nullable(), lastCheckedAt: z.number().nullable(),
      lastDrift: z.number().int().nullable(), lastError: z.string().nullable() })),
  },
  github: {
    pullRequest: oc.input(z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      branch: z.string().min(1).max(160), commit: z.string().regex(/^[a-f0-9]{40}$/) }))
      .output(z.object({ number: z.number().int().positive(), url: z.string().url(), branch: z.string(), commit: z.string() }).nullable()),
    configure: oc.input(z.object({ repositories: z.array(z.object({
      name: z.string().regex(/^[\w.-]+\/[\w.-]+$/), ref: z.string().default('main'),
    })).max(30),
      /** Legacy P6-4 alias for inbox.acceptMode.set: observe -> observe, act -> act-with-approval. */
      mode: z.enum(['observe', 'act']).optional(), botId: z.string().min(1).optional(),
      token: z.string().min(1).optional() })).output(z.object({ ok: z.boolean() })),
    status: oc.output(z.object({ repositories: z.array(z.object({ name: z.string(), ref: z.string() })),
      mode: acceptModeSchema, botId: z.string().optional(), hasToken: z.boolean(), pausedUntil: z.number().nullable(), stopped: z.boolean() })),
    poll: oc.output(z.object({ checked: z.number().int(), created: z.number().int(),
      pausedUntil: z.number().nullable() })),
  },
  events: oc.input(z.object({ since: z.number().int().nonnegative().default(0) }))
    .output(eventIterator(inboxEventSchema)),
  cron: {
    create: oc.input(z.object({ text: z.string().min(1), botId: z.string().min(1),
      schedule: z.string().min(1), mode: z.enum(['observe', 'act']).default('observe') }))
      .output(z.object({ id: z.string(), text: z.string(), botId: z.string(),
      schedule: z.string(), mode: z.enum(['observe', 'act']),
      requesterRole: z.enum(['member', 'admin', 'owner']).optional(), workspace: z.string().optional() })),
    list: oc.output(z.array(z.object({ id: z.string(), text: z.string(), botId: z.string(),
      schedule: z.string(), mode: z.enum(['observe', 'act']),
      requesterRole: z.enum(['member', 'admin', 'owner']).optional(), workspace: z.string().optional() }))),
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

export const neoContract = {
  apps: appsContract, ...baseNeoContract, agents: agentsContract, inbox: inboxContract };
