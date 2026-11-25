import { createElement, type ReactNode } from 'react';

export const maxMarkdownLength = 4096;
export const maxMarkdownDepth = 8;

// Only these fixed tags are ever constructed. Source text never becomes attributes or HTML.
type InlineTag = 'strong' | 'em' | 's' | 'code';
const inlinePatterns: { tag: InlineTag; pattern: RegExp }[] = [
  { tag: 'code', pattern: /^`([^`\n]+)`/ },
  { tag: 'strong', pattern: /^\*\*(\S(?:[^\n]*?\S)?)\*\*(?!\*)/ },
  { tag: 'strong', pattern: /^__(\S(?:[^\n]*?\S)?)__(?!_)/ },
  { tag: 's', pattern: /^~~(\S(?:[^\n]*?\S)?)~~/ },
  { tag: 'em', pattern: /^\*(\S(?:[^*\n]*?\S)?)\*/ },
  { tag: 'em', pattern: /^_(\S(?:[^_\n]*?\S)?)_/ },
];

function inline(text: string, depth: number): ReactNode[] {
  if (depth >= maxMarkdownDepth) return [text];
  const nodes: ReactNode[] = [];
  let plain = '';
  function flush() {
    if (plain) nodes.push(plain);
    plain = '';
  }
  for (let offset = 0; offset < text.length;) {
    const rest = text.slice(offset);
    // Keep link/image syntax and raw tags literal, including their contents.
    const literal = /^(?:<[^>\n]*>|!?\[[^\]\n]*\](?:\([^\n)]*\)|\[[^\]\n]*\]))/.exec(rest);
    if (literal) {
      plain += literal[0];
      offset += literal[0].length;
      continue;
    }
    const breakMatch = /^(?: {2,}|\\)\n/.exec(rest);
    if (breakMatch) {
      flush();
      nodes.push(createElement('br', { key: offset }));
      offset += breakMatch[0].length;
      continue;
    }
    if (rest[0] === '\\' && /^[\\`*_~]/.test(rest[1] ?? '')) {
      plain += rest[1];
      offset += 2;
      continue;
    }
    let matched = false;
    for (const { tag, pattern } of inlinePatterns) {
      const match = pattern.exec(rest);
      if (!match) continue;
      flush();
      nodes.push(createElement(tag, { key: offset }, tag === 'code' ? match[1] : inline(match[1], depth + 1)));
      offset += match[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      plain += rest[0];
      offset++;
    }
  }
  flush();
  return nodes;
}

const quote = /^ {0,3}> ?/;
const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const list = /^ {0,3}([-+*]|\d{1,9}[.)]) +(.+)$/;
const indent = /^(?: {4}|\t)/;
const blank = /^\s*$/;

function blocks(lines: string[], depth: number): ReactNode[] {
  if (depth >= maxMarkdownDepth) return [lines.join('\n')];
  const nodes: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const key = index;
    const line = lines[index];
    if (blank.test(line)) {
      index++;
      continue;
    }
    const opening = fence.exec(line);
    if (opening) {
      const body: string[] = [];
      index++;
      const closing = new RegExp('^ {0,3}' + opening[1][0] + '{' + opening[1].length + ',} *$');
      while (index < lines.length && !closing.test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index++;
      nodes.push(createElement('pre', { key }, createElement('code', null, body.join('\n'))));
      continue;
    }
    if (indent.test(line)) {
      const body: string[] = [];
      while (index < lines.length && indent.test(lines[index])) body.push(lines[index++].replace(indent, ''));
      nodes.push(createElement('pre', { key }, createElement('code', null, body.join('\n'))));
      continue;
    }
    if (quote.test(line)) {
      const body: string[] = [];
      while (index < lines.length && quote.test(lines[index])) body.push(lines[index++].replace(quote, ''));
      nodes.push(createElement('blockquote', { key }, blocks(body, depth + 1)));
      continue;
    }
    const firstItem = list.exec(line);
    if (firstItem) {
      const ordered = /^\d/.test(firstItem[1]);
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = list.exec(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(createElement('li', { key: index }, inline(item[2], depth + 1)));
        index++;
      }
      nodes.push(createElement(ordered ? 'ol' : 'ul', { key }, items));
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && ![blank, fence, indent, quote, list].some((pattern) => pattern.test(lines[index]))) {
      paragraph.push(lines[index++]);
    }
    nodes.push(createElement('p', { key }, inline(paragraph.join('\n'), depth + 1)));
  }
  return nodes;
}

/** Render a bounded Markdown subset with React text escaping and no HTML parser. */
export function renderMarkdown(text: string): ReactNode[] {
  return blocks(text.slice(0, maxMarkdownLength).replace(/\r\n?/g, '\n').split('\n'), 0);
}
