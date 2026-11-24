import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogId } from '../src/catalog.js';
import { maxAssistantChars, parseAssistant } from '../src/parse.js';

const surfaceId = 'survey';
const fence = (body: string) => ['```a2ui', body, '```', ''].join('\n');
const create = (components: unknown[], options: object = {}) => ({
  version: '1.0', createSurface: { surfaceId, catalogId, components, ...options },
});
const text = { id: 'root', component: 'Text', text: 'Hello' };
const form = [
  { id: 'root', component: 'Column', children: ['title', 'name', 'subscribe', 'submit'] },
  { id: 'title', component: 'Heading', text: 'Survey' },
  { id: 'name', component: 'TextField', label: 'Name', value: { '@path': '/name' } },
  { id: 'subscribe', component: 'CheckBox', label: 'Subscribe', value: { '@path': '/subscribe' } },
  { id: 'submit', component: 'Button', child: 'label', action: { event: {
    name: 'submit', context: { name: { '@path': '/name' }, wantsMail: { '@path': '/subscribe' } },
  } } },
  { id: 'label', component: 'Text', text: 'Send' },
];

test('extracts complete ordered segments and validates visible action bindings', () => {
  const input = 'Before\n' + fence(JSON.stringify([create(form), {
    version: '1.0', updateDataModel: { surfaceId, path: '/name', value: 'Ada' },
  }])) + 'After';
  const [before, middle, after] = parseAssistant(input);
  assert.deepEqual(before, { kind: 'text', text: 'Before\n' });
  assert.deepEqual(after, { kind: 'text', text: 'After' });
  assert.equal(middle.kind, 'surface');
  if (middle.kind !== 'surface') return;
  assert.deepEqual(middle.surface.message.createSurface.dataModel, { name: 'Ada', subscribe: false });
  assert.deepEqual(middle.surface.actions, [{ componentId: 'submit', name: 'submit', fields: {
    name: { path: '/name', type: 'string' }, wantsMail: { path: '/subscribe', type: 'boolean' },
  } }]);
});

test('preserves malformed, oversized, nested and hostile fences as text', () => {
  const valid = fence(JSON.stringify([create([text])]));
  const unsafe = [
    '{', JSON.stringify([create([{ ...text, href: 'javascript:alert(1)' }])]),
    JSON.stringify([create([{ ...text, component: 'McpApp' }])]),
    JSON.stringify([create([{ ...text, component: 'Image', url: 'https://example.com' }])]),
    JSON.stringify([create([{ ...text, text: { '@call': 'callMcpTool' } }])]),
    JSON.stringify([create([{ id: 'root', component: 'Column', children: ['root'] }])]),
    JSON.stringify([create([{ id: 'root', component: 'Column', children: ['missing'] }])]),
    JSON.stringify([create([text], { dataModel: { secret: 'hidden' } })]),
    JSON.stringify([create([text], { catalogId: 'foreign' })]),
    JSON.stringify([create([text], { sendDataModel: true })]),
    JSON.stringify([create([text, { ...text, id: 'constructor' }])]),
    JSON.stringify([create([text, text])]), JSON.stringify([create([text]), create([text])]),
    JSON.stringify(Array.from({ length: 25 }, () => create([text]))),
    JSON.stringify([create([{ ...text, text: 'x'.repeat(33 * 1024) }])]),
    JSON.stringify([{ version: '1.0', callRendererFunction: {} }]),
  ];
  for (const body of unsafe) assert.deepEqual(parseAssistant(fence(body)), [{ kind: 'text', text: fence(body) }]);
  for (const input of ['~~~ markdown\n' + valid + '~~~\n', valid.slice(0, -4),
    'x'.repeat(maxAssistantChars) + '\n' + valid]) {
    assert.deepEqual(parseAssistant(input), [{ kind: 'text', text: input }]);
  }
  assert.deepEqual(parseAssistant(valid + valid).map(({ kind }) => kind), ['surface', 'text']);
});
