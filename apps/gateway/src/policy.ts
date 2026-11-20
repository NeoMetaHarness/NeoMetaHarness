import { ORPCError } from '@orpc/server';
import {
  requireViewer,
  requireMember,
  requireAdminOrOwner,
  requireOwner,
  type GatewayAuthContext,
} from './rbac.js';

export type PolicyLevel = 'viewer' | 'member' | 'admin' | 'owner' | 'deployment-owner' | 'internal';

/** Approval metadata identifies tool calls that can erase or replace user data. */
export function destructiveToolApproval(tool: string, detail: string): boolean {
  return /\b(delete|destroy|erase|wipe|purge|truncate|drop|remove|overwrite|format|reset|revoke)\b/i
    .test(`${tool} ${detail}`);
}

/** Shared resources require deployment ownership on a server. Keep the original desktop roles. */
const DEPLOYMENT_PROCEDURE_DESKTOP_POLICY: Readonly<Record<string, PolicyLevel>> = {
  // Hermes runtime, profiles, and dashboard
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
  // Channels and sender allowlists
  'x.channels.notification.resolve': 'member',
  'x.channels.list': 'viewer',
  'x.channels.status': 'viewer',
  'x.channels.connect': 'admin',
  'x.channels.disconnect': 'admin',
  'x.channels.senders': 'admin',
  'x.channels.allow': 'admin',
  'x.channels.revoke': 'admin',
  'x.channels.approve': 'admin',
  // GitHub source and upstream routine
  'inbox.upstream.check': 'admin',
  'inbox.github.pullRequest': 'viewer',
  'inbox.upstream.configure': 'admin',
  'inbox.upstream.status': 'viewer',
  'inbox.github.configure': 'admin',
  'inbox.github.status': 'viewer',
  'inbox.github.poll': 'admin',
  // Extension lifecycle
  'extensions.enable': 'admin',
  'extensions.disable': 'admin',
  // Shared Skills Registry mutations
  'x.skills-registry.import': 'member',
  'x.skills-registry.sync': 'member',
  'x.skills-registry.rollback': 'member',
  'x.skills-registry.assign': 'admin',
  'x.skills-registry.checks.set': 'admin',
  'x.skills-registry.autonomy.set': 'admin',
  'x.skills-registry.evaluate': 'admin',
  'x.skills-registry.override': 'admin',
  'x.skills-registry.ceiling.set': 'admin',
  'x.skills-registry.hub.scan': 'member',
  'x.skills-registry.hub.approve': 'admin',
  'x.skills-registry.hub.install': 'member',
};

export const CONTRACT_POLICY: Record<string, PolicyLevel> = {
  ...Object.fromEntries(Object.keys(DEPLOYMENT_PROCEDURE_DESKTOP_POLICY).map((path) => [path, 'deployment-owner'])),
  'system.transferDeploymentOwner': 'deployment-owner',
  'system.backup': 'deployment-owner',
  'system.restore': 'deployment-owner',
  'x.metrics.summary': 'admin',
  'x.coding-workflow.register': 'admin',
  'x.coding-workflow.switch': 'member',
  'x.coding-workflow.worktree': 'member',
  'x.coding-workflow.terminal.open': 'member',
  'x.coding-workflow.terminal.output': 'viewer',
  'x.coding-workflow.terminal.run': 'member',
  'x.coding-workflow.prepare': 'member',
  'onboarding.get': 'admin',
  'onboarding.complete': 'admin',
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
  'x.memory-local.intents.list': 'viewer',
  'x.memory-local.intents.add': 'admin',
  'x.memory-local.intents.update': 'admin',
  'x.memory-local.intents.retract': 'admin',

  // x.memory-honcho
  'x.memory-honcho.status': 'viewer',
  'x.memory-honcho.list': 'viewer',
  // A dream only proposes; writing waits for the accept mode or an Inbox decision.
  'x.memory-honcho.dream.run': 'member',
  'x.memory-honcho.dream.last': 'viewer',

  // x.skills-registry
  'x.skills-registry.list': 'viewer',
  'x.skills-registry.get': 'viewer',
  'x.skills-registry.versions': 'viewer',
  'x.skills-registry.diff': 'viewer',
  'x.skills-registry.assignments': 'viewer',
  'x.skills-registry.ceiling.get': 'viewer',

  // x.models
  'x.models-router-panda.settings.get': 'admin',
  'x.models-router-panda.settings.set': 'admin',
  'x.models-router-panda.health': 'viewer',
  'x.models.providers.list': 'viewer',
  'x.models.providers.put': 'admin',
  'x.models.providers.delete': 'admin',
  'x.models.providers.test': 'admin',
  'x.models.override.get': 'viewer',
  'x.models.roles.get': 'viewer',
  'x.models.roles.set': 'admin',
  'x.models.override.set': 'admin',
  // The deployment's own model and router configuration (Hermes profiles, registry evaluation): P1-13 / P1-14.
  'x.models.deployment.providers.list': 'deployment-owner',
  'x.models.deployment.providers.put': 'deployment-owner',
  'x.models.deployment.providers.delete': 'deployment-owner',
  'x.models.deployment.providers.test': 'deployment-owner',
  'x.models.deployment.roles.get': 'deployment-owner',
  'x.models.deployment.roles.set': 'deployment-owner',
  'x.models.deployment.override.get': 'deployment-owner',
  'x.models.deployment.override.set': 'deployment-owner',
  'x.models-router-panda.deployment.settings.get': 'deployment-owner',
  'x.models-router-panda.deployment.settings.set': 'deployment-owner',

  // x.voice-xai
  'x.voice-xai.status': 'viewer',
  'x.voice-xai.transcribe': 'member',
  'x.voice-xai.synthesize': 'member',
  // x.search (external, metered requests require a member)
  'x.x-search.status': 'viewer',
  'x.x-search.search': 'member',

  // extensions
  'extensions.list': 'viewer',
  'extensions.upgrade': 'deployment-owner',
  'extensions.uninstall': 'deployment-owner',

  // settings
  'settings.get': 'viewer',
  'settings.set': 'admin',

  // vault
  'vault.list': 'viewer',
  'vault.put': 'member',
  'vault.rotate': 'member',
  'vault.delete': 'admin',

  // computers
  'computers.policy.get': 'admin',
  'computers.policy.set': 'admin',
  'computers.list': 'viewer',
  'computers.provision': 'admin',
  'computers.attach': 'admin',
  'computers.release': 'admin',
  'computers.terminate': 'admin',
  'computers.lease': 'admin',
  'computers.assign': 'admin',
  'computers.kill': 'admin',
  'computers.state': 'viewer',
  'computers.capture': 'admin',
  'computers.local.status': 'viewer',
  'computers.local.set': 'owner',

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
  'inbox.dismiss': 'member',
  'inbox.acceptMode.get': 'viewer',
  'inbox.acceptMode.set': 'admin',
  'inbox.acceptMode.deployment.get': 'deployment-owner',
  'inbox.acceptMode.deployment.set': 'deployment-owner',
  'inbox.reply': 'member',
  'inbox.approval.decide': 'member',
  'inbox.retry': 'member',
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
  '/internal/computers-mcp/action': 'internal',
  '/x/computers-mcp/action': 'internal',
  '/internal/computers/action': 'internal',
  '/x/computer-local/consent': 'owner',
  '/x/computer-boat/snapshot': 'admin',
  '/auth/ws-ticket': 'viewer',
  '/auth/organization/create': 'deployment-owner',
  '/x/backup/backup': 'deployment-owner',
  '/x/backup/restore': 'deployment-owner',
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

export function authorize(path: string, context?: GatewayAuthContext, { workspaceOnly = false } = {}): void {
  if ((path === 'inbox.list' || path === 'inbox.events' || path === 'inbox.cron.list') && canSeeDeploymentItems(context)) return;
  const level = (context?.deploymentMode === 'desktop' && Object.hasOwn(DEPLOYMENT_PROCEDURE_DESKTOP_POLICY, path))
    ? DEPLOYMENT_PROCEDURE_DESKTOP_POLICY[path] : getPolicy(path);
  if (!level) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      message: `No authorization policy configured for route: ${path}`,
    });
  }
  // The handler checks the settings or vault scope once it has the input.
  if (!workspaceOnly && context?.deploymentMode === 'server'
    && (path === 'settings.get' || path === 'settings.set' || path.startsWith('vault.')) && canSeeDeploymentItems(context)) return;

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
    case 'deployment-owner':
      // Desktop keeps workspace-owner authorization for its local operations.
      if (context?.deploymentMode === 'desktop' && path !== 'system.transferDeploymentOwner') {
        requireOwner(context);
      } else requireDeploymentOwner(context);
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

// These extensions serve one deployment-wide runtime or registry. Kernel settings
// secrets use the same extension ID as the engine vault subject.
// Superagent shares one GitHub source, upstream routine, and deployment accept mode.
// Keep its settings scope aligned with those services if it adds a schema.
const DEPLOYMENT_SCOPED_EXTENSIONS = new Set(['engine-hermes', 'channels', 'engine-superagent', 'skills-registry']);

export function hasDeploymentSettings(extension: string): boolean {
  return DEPLOYMENT_SCOPED_EXTENSIONS.has(extension);
}

export function authorizeDeploymentSettings(extension: string | undefined, context?: GatewayAuthContext): boolean {
  if (context?.deploymentMode !== 'server' || !extension || !hasDeploymentSettings(extension)) return false;
  requireDeploymentOwner(context);
  return true;
}

/** Deployment owners may reach the lookup. Workspace items still require the normal role after lookup. */
export function authorizeInboxAction(
  path: string, context?: GatewayAuthContext, scope?: 'deployment' | 'workspace',
): GatewayAuthContext['role'] {
  if (context?.deploymentMode === 'server') {
    if (scope === 'deployment') {
      requireDeploymentOwner(context);
      return 'owner';
    }
    if (!scope && canSeeDeploymentItems(context)) return context.role;
  }
  authorize(path, context);
  return context!.role;
}

export function canSeeDeploymentItems(context?: GatewayAuthContext): boolean {
  return Boolean(context?.user && context.session && context.isDeploymentOwner?.());
}

export function requireDeploymentOwner(context?: GatewayAuthContext): void {
  if (!context?.user) throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' });
  if (!canSeeDeploymentItems(context)) throw new ORPCError('FORBIDDEN', { message: 'Deployment owner required' });
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

const INBOX_ITEM_ACTIONS = new Set([
  'inbox.accept', 'inbox.dismiss', 'inbox.reply', 'inbox.approval.decide', 'inbox.retry',
  'inbox.cron.delete', 'inbox.cron.fire',
]);

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
  if (procedure in CONTRACT_POLICY) {
    if (INBOX_ITEM_ACTIONS.has(procedure)) authorizeInboxAction(procedure, context);
    else authorize(procedure, context);
  }
  return next();
}
