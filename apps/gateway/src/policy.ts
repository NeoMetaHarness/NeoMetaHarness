import { ORPCError } from '@orpc/server';
import {
  requireViewer,
  requireMember,
  requireAdminOrOwner,
  requireOwner,
  type GatewayAuthContext,
} from './rbac.js';

export type PolicyLevel = 'viewer' | 'member' | 'admin' | 'owner' | 'internal';

/** Approval metadata identifies tool calls that can erase or replace user data. */
export function destructiveToolApproval(tool: string, detail: string): boolean {
  return /\b(delete|destroy|erase|wipe|purge|truncate|drop|remove|overwrite|format|reset|revoke)\b/i
    .test(`${tool} ${detail}`);
}

export const CONTRACT_POLICY: Record<string, PolicyLevel> = {
  'system.backup': 'owner',
  'system.restore': 'owner',
  // x.engine-t3
  'x.engine-t3.create': 'member',
  'x.engine-t3.send': 'member',
  'x.engine-t3.events': 'viewer',
  'x.engine-t3.approval': 'member',
  'x.engine-t3.settle': 'member',
  'x.engine-t3.stop': 'member',
  'x.engine-t3.diff': 'viewer',
  'x.engine-t3.rollback': 'member',
  'x.engine-t3.providers.list': 'viewer',
  'x.engine-t3.threads.list': 'viewer',

  // x.engine-hermes
  'x.engine-hermes.skills.list': 'viewer',
  'x.engine-hermes.skills.hub': 'viewer',
  'x.engine-hermes.skills.preview': 'viewer',
  'x.engine-hermes.skills.scan': 'viewer',
  'x.engine-hermes.skills.curator': 'viewer',
  'x.engine-hermes.skills.pause': 'member',
  'x.engine-hermes.skills.run': 'member',
  'x.engine-hermes.skills.graph': 'viewer',
  'x.engine-hermes.skills.learn': 'member',
  'x.engine-hermes.profiles.list': 'viewer',
  'x.engine-hermes.profiles.create': 'member',
  'x.engine-hermes.profiles.delete': 'member',
  'x.engine-hermes.runs.start': 'member',
  'x.engine-hermes.runs.events': 'viewer',
  'x.engine-hermes.runs.approve': 'member',
  'x.engine-hermes.runs.stop': 'member',
  'x.engine-hermes.cron.list': 'viewer',
  'x.engine-hermes.cron.create': 'member',
  'x.engine-hermes.cron.delete': 'member',
  'x.engine-hermes.cron.update': 'member',
  'x.engine-hermes.cron.pause': 'member',
  'x.engine-hermes.cron.trigger': 'member',
  'x.engine-hermes.cron.history': 'viewer',
  'x.engine-hermes.kanban.boards': 'viewer',
  'x.engine-hermes.kanban.createBoard': 'member',
  'x.engine-hermes.kanban.board': 'viewer',
  'x.engine-hermes.kanban.create': 'member',
  'x.engine-hermes.kanban.assign': 'member',
  'x.engine-hermes.kanban.task': 'viewer',
  'x.engine-hermes.kanban.dispatch': 'member',

  // x.engine-dsh
  'x.engine-dsh.create': 'member',
  'x.engine-dsh.prompt': 'member',
  'x.engine-dsh.events': 'viewer',
  'x.engine-dsh.wait': 'member',
  'x.engine-dsh.cancel': 'member',
  'x.engine-dsh.shutdown': 'member',

  // x.memory-local
  'x.memory-local.list': 'viewer',
  'x.memory-local.add': 'member',
  'x.memory-local.update': 'member',
  'x.memory-local.delete': 'member',
  'x.memory-local.export': 'viewer',

  // x.memory-honcho
  'x.memory-honcho.status': 'viewer',
  'x.memory-honcho.list': 'viewer',

  // x.skills-registry
  'x.skills-registry.list': 'viewer',
  'x.skills-registry.get': 'viewer',
  'x.skills-registry.import': 'member',
  'x.skills-registry.sync': 'member',
  'x.skills-registry.versions': 'viewer',
  'x.skills-registry.diff': 'viewer',
  'x.skills-registry.rollback': 'member',
  'x.skills-registry.assign': 'admin',
  'x.skills-registry.assignments': 'viewer',
  'x.skills-registry.checks.set': 'admin',
  'x.skills-registry.autonomy.set': 'admin',
  'x.skills-registry.evaluate': 'admin',
  'x.skills-registry.override': 'admin',
  'x.skills-registry.ceiling.get': 'viewer',
  'x.skills-registry.ceiling.set': 'admin',
  'x.skills-registry.hub.scan': 'member',
  'x.skills-registry.hub.approve': 'admin',
  'x.skills-registry.hub.install': 'member',

  // x.channels (channel tokens are workspace config)
  'x.channels.list': 'viewer',
  'x.channels.status': 'viewer',
  'x.channels.connect': 'admin',
  'x.channels.disconnect': 'admin',

  // x.models
  'x.models.providers.list': 'viewer',
  'x.models.providers.put': 'admin',
  'x.models.providers.delete': 'admin',
  'x.models.providers.test': 'admin',
  'x.models.override.get': 'viewer',
  'x.models.roles.get': 'viewer',
  'x.models.roles.set': 'admin',
  'x.models.override.set': 'admin',

  // extensions
  'extensions.list': 'viewer',
  'extensions.enable': 'admin',
  'extensions.disable': 'admin',

  // vault
  'vault.list': 'viewer',
  'vault.put': 'member',
  'vault.rotate': 'member',
  'vault.delete': 'admin',

  // computers
  'computers.list': 'viewer',
  'computers.attach': 'admin',
  'computers.release': 'admin',
  'computers.lease': 'admin',
  'computers.assign': 'admin',
  'computers.kill': 'admin',
  'computers.state': 'viewer',
  'computers.capture': 'admin',

  // events
  'events.subscribe': 'viewer',

  // agents.bots
  'agents.bots.list': 'viewer',
  'agents.bots.create': 'member',
  'agents.bots.update': 'member',
  'agents.bots.delete': 'member',

  // agents.turns
  'agents.turns.send': 'member',
  'agents.turns.events': 'viewer',
  'agents.turns.stop': 'member',
  'agents.turns.list': 'viewer',

  // agents.approvals
  'agents.approvals.list': 'viewer',
  'agents.approvals.resolve': 'member',

  // agents.rooms
  'agents.rooms.list': 'viewer',
  'agents.rooms.create': 'member',
  'agents.rooms.post': 'member',
  'agents.rooms.events': 'viewer',

  // agents.tasks
  'agents.tasks.list': 'viewer',
  'agents.tasks.create': 'member',
  'agents.tasks.update': 'member',

  // agents.routines
  'agents.routines.list': 'viewer',
  'agents.routines.create': 'member',
  'agents.routines.enable': 'member',

  // inbox
  'inbox.ask': 'viewer',
  'inbox.list': 'viewer',
  'inbox.decisions.list': 'viewer',
  'inbox.accept': 'member',
  'inbox.reply': 'member',
  'inbox.approval.decide': 'member',
  'inbox.retry': 'member',
  'inbox.upstream.check': 'admin',
  'inbox.events': 'viewer',
  'inbox.cron.create': 'member',
  'inbox.cron.list': 'viewer',
  'inbox.cron.delete': 'member',
  'inbox.cron.fire': 'admin',
  'inbox.channel.emit': 'admin',
  'inbox.channel.replies': 'admin',
};

export const HTTP_ROUTE_POLICY: Record<string, PolicyLevel> = {
  '/internal/memory/context': 'internal',
  '/internal/memory/write': 'internal',
  '/internal/computers/action': 'internal',
  '/auth/ws-ticket': 'viewer',
  '/auth/*': 'internal',
  '/x/*': 'viewer',
};

export const ROUTE_POLICY: Record<string, PolicyLevel> = {
  ...CONTRACT_POLICY,
  ...HTTP_ROUTE_POLICY,
};

export function getPolicy(path: string): PolicyLevel | undefined {
  if (path in ROUTE_POLICY) {
    return ROUTE_POLICY[path];
  }
  if (path.startsWith('/x/')) {
    return ROUTE_POLICY['/x/*'];
  }
  if (path.startsWith('/auth/')) {
    return ROUTE_POLICY['/auth/*'];
  }
  return undefined;
}

export function authorize(path: string, context?: GatewayAuthContext): void {
  const level = getPolicy(path);
  if (!level) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: `No authorization policy configured for route: ${path}`,
    });
  }

  switch (level) {
    case 'viewer':
      requireViewer(context);
      break;
    case 'member':
      requireMember(context);
      break;
    case 'admin':
      requireAdminOrOwner(context);
      break;
    case 'owner':
      requireOwner(context);
      break;
    case 'internal':
      throw new ORPCError('FORBIDDEN', {
        message: `Route ${path} is internal and cannot be invoked via user RPC`,
      });
    default: {
      const _exhaustive: never = level;
      throw new ORPCError('INTERNAL_SERVER_ERROR', {
        message: `Unknown policy level for route: ${path}`,
      });
    }
  }
}

export function getContractProcedurePaths(contract: any, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(contract)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      value &&
      typeof value === 'object' &&
      ('~orpc' in value || 'route' in value || 'inputSchema' in value || 'outputSchema' in value)
    ) {
      paths.push(path);
    } else if (value && typeof value === 'object') {
      paths.push(...getContractProcedurePaths(value, path));
    }
  }
  return paths;
}

/**
 * oRPC middleware registered on the implementer, so it runs before input
 * validation (SEC-13): a caller without the required role is refused by policy
 * before the validator can describe the procedure's input schema. Handlers keep
 * their own authorize() calls; this only moves the first check earlier.
 */
export function policyMiddleware({ context, path, next }: {
  context: GatewayAuthContext; path: readonly string[]; next: () => any;
}) {
  const procedure = path.join('.');
  if (procedure in CONTRACT_POLICY) authorize(procedure, context);
  return next();
}
