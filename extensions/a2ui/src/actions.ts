import { randomUUID } from 'node:crypto';
import { RendererToAgentMessageSchema } from '@a2ui/web_core/v1_0';
import type { A2uiActionInput, A2uiActionResult } from '@neometaharness/contracts';
import { ORPCError } from '@orpc/server';
import { maxInputLength, type SurfaceAction } from './catalog.js';

export type Actor = { userId: string; workspaceId: string };
export type ActionTarget = {
  actor: Actor;
  conversationId: string;
  revision: string;
  send: (text: string) => Promise<A2uiActionResult>;
};

type Grant = {
  handle: string;
  key: string;
  expires: number;
  target: ActionTarget;
  surfaceId: string;
  action: SurfaceAction;
  request?: { key: string; fields: string; result: Promise<A2uiActionResult> };
};

const maxGrants = 2048;
const grantLifetime = 30 * 60 * 1000;

export class ActionStore {
  private grants = new Map<string, Grant>();
  private handlesByKey = new Map<string, string>();
  private closed = false;

  issue(target: ActionTarget, surfaceId: string, action: SurfaceAction): string | undefined {
    if (this.closed) return;
    const now = Date.now();
    this.prune(now);
    const key = JSON.stringify([target.actor.workspaceId, target.actor.userId, target.conversationId,
      target.revision, surfaceId, action.componentId]);
    const existing = this.handlesByKey.get(key);
    if (existing) return existing;
    if (this.grants.size >= maxGrants) return;
    const handle = randomUUID();
    this.grants.set(handle, { handle, key, expires: now + grantLifetime, target, surfaceId, action });
    this.handlesByKey.set(key, handle);
    return handle;
  }

  dispatch(actor: Actor, input: A2uiActionInput): Promise<A2uiActionResult> {
    const grant = this.grants.get(input.handle);
    if (!grant || grant.expires <= Date.now() || grant.target.actor.userId !== actor.userId ||
        grant.target.actor.workspaceId !== actor.workspaceId) {
      throw new ORPCError('NOT_FOUND', { message: 'Action is unavailable.' });
    }
    const keys = Object.keys(grant.action.fields).sort();
    if (keys.length !== Object.keys(input.fields).length || keys.some((key) => {
      const value = input.fields[key];
      return !Object.hasOwn(input.fields, key) || typeof value !== grant.action.fields[key].type ||
        (typeof value === 'string' && value.length > maxInputLength);
    })) throw new ORPCError('BAD_REQUEST', { message: 'Action fields do not match the control.' });

    const fields = JSON.stringify(keys.map((key) => input.fields[key]));
    if (grant.request) {
      if (grant.request.key === input.idempotencyKey && grant.request.fields === fields) return grant.request.result;
      throw new ORPCError('CONFLICT', { message: 'This action has already been submitted.' });
    }
    const message = {
      version: '1.0',
      action: {
        surfaceId: grant.surfaceId, sourceComponentId: grant.action.componentId, name: grant.action.name,
        timestamp: new Date().toISOString(), context: input.fields,
      },
    };
    if (!RendererToAgentMessageSchema.safeParse(message).success) throw new Error('Invalid A2UI action envelope');
    // Reserve before dispatch. Keep the same promise even after an ambiguous transport failure.
    const result = Promise.resolve().then(() => {
      if (this.closed) throw new ORPCError('NOT_FOUND', { message: 'Action is unavailable.' });
      return grant.target.send(JSON.stringify(message));
    });
    grant.request = { key: input.idempotencyKey, fields, result };
    return result;
  }

  close() {
    this.closed = true;
    this.grants.clear();
    this.handlesByKey.clear();
  }

  private prune(now: number) {
    for (const grant of this.grants.values()) {
      if (grant.expires > now) continue;
      this.grants.delete(grant.handle);
      this.handlesByKey.delete(grant.key);
    }
  }
}
