import type { A2uiActionInput } from '@neometaharness/contracts';
import { defineExtension } from '@neometaharness/kernel';
import { ORPCError } from '@orpc/server';
import { ActionStore, type Actor, type ActionTarget } from './actions.js';
import { parseAssistant } from './parse.js';

export default defineExtension({
  activate(ctx) {
    const actions = new ActionStore();
    ctx.onDrain(() => actions.close());
    ctx.effect(() => () => actions.close());
    ctx.route('action', ({ method, body }) => {
      if (method !== 'RPC') throw new ORPCError('FORBIDDEN');
      const { actor, input } = body as { actor: Actor; input: A2uiActionInput };
      return actions.dispatch(actor, input);
    });
    ctx.route('segments', ({ method, body }) => {
      if (method !== 'RPC') throw new ORPCError('FORBIDDEN');
      const { text, target } = body as { text: string; target?: ActionTarget };
      const segments = parseAssistant(text);
      if (segments.every(({ kind }) => kind === 'text')) return undefined;
      return segments.map((segment) => {
        if (segment.kind === 'text') return segment;
        const { message, actions: definitions } = segment.surface;
        const buttons = definitions.flatMap((action) => {
          const handle = target && actions.issue(target, message.createSurface.surfaceId, action);
          return handle ? [[action.componentId, {
            handle, fields: Object.fromEntries(Object.entries(action.fields).map(([key, field]) => [key, field.path])),
          }] as const] : [];
        });
        return { kind: 'surface', message, actions: Object.fromEntries(buttons) };
      });
    });
  },
});
