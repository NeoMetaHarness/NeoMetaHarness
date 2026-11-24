import type { A2uiActionInput } from '@neometaharness/contracts';
import { defineExtension } from '@neometaharness/kernel';
import { ORPCError } from '@orpc/server';
import { ActionStore, type Actor, type ActionTarget } from './actions.js';
import { catalogId } from './catalog.js';
import { parseAssistant } from './parse.js';

const instructions = [
  'When an interactive reply helps, include a Markdown fence labeled a2ui containing a JSON array.',
  'Use A2UI 1.0 with a createSurface message and a unique surfaceId. Use exactly the catalog ID and shape shown below.',
  'Supported components: Text(text), Heading(text), Column(children), Button(child,action), CheckBox(label,value), TextField(label,value).',
  'Every component has an id and component name. The tree begins at root. A Button child is a plain Text label.',
  'Inputs bind to distinct top-level data paths, e.g. {"@path":"/name"}. Initialize top-level string or boolean fields in dataModel.',
  'An action has event.name and optional event.context. Every context value must be a path to a visible input.',
  'No links, images, hidden fields, functions, HTML or CSS. Prefer normal prose when a form or other interactive surface is unnecessary.',
  'Example:',
  '```a2ui',
  JSON.stringify([{ version: '1.0', createSurface: { surfaceId: 'survey', catalogId, dataModel: { name: '' }, components: [
    { id: 'root', component: 'Column', children: ['field', 'submit'] },
    { id: 'field', component: 'TextField', label: 'Name', value: { '@path': '/name' } },
    { id: 'submit', component: 'Button', child: 'label', action: {
      event: { name: 'submit', context: { name: { '@path': '/name' } } },
    } },
    { id: 'label', component: 'Text', text: 'Submit' },
  ] } }]),
  '```',
  'User submissions arrive as a JSON A2UI 1.0 action. Use that action as a user reply and continue this conversation.',
].join('\n');

export default defineExtension({
  activate(ctx) {
    const actions = new ActionStore();
    ctx.onDrain(() => actions.close());
    ctx.effect(() => () => actions.close());
    ctx.route('instructions', ({ method }) => {
      if (method !== 'RPC') throw new ORPCError('FORBIDDEN');
      return instructions;
    });
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
