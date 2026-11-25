import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidElement, type ReactNode } from 'react';
import { maxMarkdownDepth, maxMarkdownLength, renderMarkdown } from '../src/markdown.js';

type Shape = string | { tag: string; children: Shape[] };

function shape(node: ReactNode): Shape[] {
  if (Array.isArray(node)) return node.flatMap(shape);
  if (typeof node === 'string') return [node];
  assert.ok(isValidElement<{ children?: ReactNode }>(node));
  assert.equal(typeof node.type, 'string');
  assert.ok(Object.keys(node.props).every((key) => key === 'children'));
  return [{ tag: String(node.type), children: node.props.children == null ? [] : shape(node.props.children) }];
}

const element = (tag: string, ...children: Shape[]): Shape => ({ tag, children });

test('renders paragraphs, strong, emphasis, strikethrough and inline code', () => {
  assert.deepEqual(shape(renderMarkdown('**bold** __also__ *italic* _also_ ~~removed~~ `<b>code</b>`\n\nNext')), [
    element('p', element('strong', 'bold'), ' ', element('strong', 'also'), ' ', element('em', 'italic'),
      ' ', element('em', 'also'), ' ', element('s', 'removed'), ' ', element('code', '<b>code</b>')),
    element('p', 'Next'),
  ]);
  assert.deepEqual(shape(renderMarkdown('**bold *nested***')), [
    element('p', element('strong', 'bold ', element('em', 'nested'))),
  ]);
});

test('renders blockquotes, unordered lists and ordered lists', () => {
  assert.deepEqual(shape(renderMarkdown('> quote\n>\n> **more**\n\n- one\n+ two\n* three\n\n1. first\n2. second')), [
    element('blockquote', element('p', 'quote'), element('p', element('strong', 'more'))),
    element('ul', element('li', 'one'), element('li', 'two'), element('li', 'three')),
    element('ol', element('li', 'first'), element('li', 'second')),
  ]);
});

test('renders fenced and indented code literally and supports hard breaks', () => {
  assert.deepEqual(shape(renderMarkdown(['```js', '<script>alert(1)</script>', '**literal**', '```', '', '    indented', '', 'one  ', 'two\\', 'three'].join('\n'))), [
    element('pre', element('code', '<script>alert(1)</script>\n**literal**')),
    element('pre', element('code', 'indented')),
    element('p', 'one', element('br'), 'two', element('br'), 'three'),
  ]);
});

test('leaves scripts, event handlers, javascript URLs, images, links and HTML as inert text', () => {
  const text = '<script>alert(1)</script> <img src=x onerror=alert(1)> <b>raw</b> '
    + '[**link**](javascript:alert(1)) ![image](https://example.com/x.png) javascript:alert(1)';
  assert.deepEqual(shape(renderMarkdown(text)), [element('p', text)]);
  assert.deepEqual(shape(renderMarkdown('# Heading\n\n<a href="javascript:alert(1)">click</a>')), [
    element('p', '# Heading'), element('p', '<a href="javascript:alert(1)">click</a>'),
  ]);
});

test('bounds input size and recursion while keeping the remaining nested text inert', () => {
  assert.deepEqual(shape(renderMarkdown('x'.repeat(maxMarkdownLength * 10))), [
    element('p', 'x'.repeat(maxMarkdownLength)),
  ]);
  const content = '<img onerror=alert(1)>';
  let expected: Shape = '>'.repeat(200 - maxMarkdownDepth) + content;
  for (let depth = 0; depth < maxMarkdownDepth; depth++) expected = element('blockquote', expected);
  assert.deepEqual(shape(renderMarkdown('>'.repeat(200) + content)), [expected]);
  assert.doesNotThrow(() => renderMarkdown('*_~'.repeat(maxMarkdownLength)));
});
