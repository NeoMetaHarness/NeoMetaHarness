import { ORPCError } from '@orpc/server';
import type { NeoAuthContext, NeoRole } from '@neometaharness/auth';

export interface GatewayAuthContext extends NeoAuthContext {
  deploymentMode?: 'server' | 'desktop';
  isDeploymentOwner?: () => boolean;
}

export function requireViewer(context?: GatewayAuthContext): void {
  if (!context?.user) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' });
  }
  if (!context.role) {
    throw new ORPCError('FORBIDDEN', { message: 'Workspace membership required' });
  }
}

export function requireMember(context?: GatewayAuthContext): void {
  if (!context?.user) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' });
  }
  if (!context.role || context.role === 'viewer') {
    throw new ORPCError('FORBIDDEN', { message: 'Member role required' });
  }
}

export function requireAdminOrOwner(context?: GatewayAuthContext): void {
  if (!context?.user) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' });
  }
  if (!context.role || (context.role !== 'owner' && context.role !== 'admin')) {
    throw new ORPCError('FORBIDDEN', { message: 'Admin or owner role required' });
  }
}

export function requireOwner(context?: GatewayAuthContext): void {
  if (!context?.user) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' });
  }
  if (!context.role || context.role !== 'owner') {
    throw new ORPCError('FORBIDDEN', { message: 'Owner role required' });
  }
}
