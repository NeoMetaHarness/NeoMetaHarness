import { ORPCError } from '@orpc/server';
import {
  requireViewer,
  requireMember,
  requireAdminOrOwner,
  requireOwner,
  type GatewayAuthContext,
} from './rbac.js';

export type PolicyLevel = 'viewer' | 'member' | 'admin' | 'owner' | 'internal';

export const CONTRACT_POLICY: Record<string, PolicyLevel> = {
  // x.engine-t3
  'x.engine-t3.create': 'member',
  'x.engine-t3.send': 'member',
  'x.engine-t3.events': 'viewer',
  'x.engine-t3.approval': 'member',
  'x.engine-t3.settle': 'member',
  'x.engine-t3.stop': 'member',
  'x.engine-t3.diff': 'viewer',
  'x.engine-t3.threads.list': 'viewer',

  // x.engine-hermes
  'x.engine-hermes.skills.list': 'viewer',
  'x.engine-hermes.skills.hub': 'viewer',
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
  'x.skills-registry.assign': 'member',
  'x.skills-registry.assignments': 'viewer',

  // x.models
  'x.models.providers.list': 'viewer',
  'x.models.providers.put': 'admin',
  'x.models.providers.delete': 'admin',
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
  'inbox.ask': 'member',
  'inbox.list': 'viewer',
  'inbox.accept': 'member',
  'inbox.events': 'viewer',
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
