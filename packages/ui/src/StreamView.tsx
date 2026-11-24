import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Text as AstryxText } from '@astryxdesign/core/Text';
import './stream-view.css';

export interface StreamViewHandle {
  append(delta: string): void;
  finish(): void;
  reset(): void;
}

const Section = memo(function Section({ markdown }: { markdown: string }) {
  return <Markdown contentWidth="100%">{markdown}</Markdown>;
});

// Scan each complete line once. Keep list continuations and fenced code together
// until their boundary is known, even when a delimiter spans several deltas.
type Boundary = { offset: number; blank: boolean; fence: { marker: string; length: number } | null };
const freshBoundary = (): Boundary => ({ offset: 0, blank: false, fence: null });

function completedBlocks(text: string, boundary: Boundary): [string[], string] {
  const blocks: string[] = [];
  let from = 0;
  let end: number;
  while ((end = text.indexOf('\n', boundary.offset)) !== -1) {
    const line = text.slice(boundary.offset, end).replace(/\r$/, '');
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (boundary.fence) {
      if (fence && fence[1][0] === boundary.fence.marker &&
        fence[1].length >= boundary.fence.length && !fence[2].trim()) {
        boundary.fence = null;
        blocks.push(text.slice(from, end + 1));
        from = end + 1;
      }
    } else {
      const continuation = /^\s|^>|^(?:[-+*]|\d+[.)])\s/.test(line);
      if (boundary.blank && line.trim() && !continuation && boundary.offset > from) {
        blocks.push(text.slice(from, boundary.offset));
        from = boundary.offset;
      }
      if (fence) boundary.fence = { marker: fence[1][0], length: fence[1].length };
    }
    boundary.blank = !line.trim();
    boundary.offset = end + 1;
  }
  boundary.offset -= from;
  return [blocks, text.slice(from)];
}

/** Hot-path deltas update one DOM Text node every ~33ms. Only complete Markdown sections enter React. */
export const StreamView = forwardRef<StreamViewHandle, { className?: string }>(function StreamView({ className }, ref) {
  const [sections, setSections] = useState<string[]>([]);
  const pending = useRef('');
  const open = useRef('');
  const boundary = useRef(freshBoundary());
  const status = useRef<HTMLSpanElement>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tailElement = useRef<HTMLDivElement>(null);
  const tailNode = useRef<Text | null>(null);

  useLayoutEffect(() => {
    const node = document.createTextNode(open.current);
    tailElement.current?.appendChild(node);
    tailNode.current = node;
    return () => {
      if (timeout.current !== null) clearTimeout(timeout.current);
      tailNode.current = null;
      node.remove();
    };
  }, []);

  const flush = () => {
    if (timeout.current !== null) clearTimeout(timeout.current);
    timeout.current = null;
    if (!pending.current) return;
    const delta = pending.current;
    const [done, tail] = completedBlocks(open.current + delta, boundary.current);
    pending.current = '';
    open.current = tail;
    if (done.length) {
      setSections((previous) => [...previous, ...done]);
      if (tailNode.current) tailNode.current.data = tail;
    } else tailNode.current?.appendData(delta);
  };

  useImperativeHandle(ref, () => ({
    append(delta) {
      if (!delta) return;
      if (status.current && status.current.textContent !== 'Generating response') {
        status.current.textContent = 'Generating response';
      }
      pending.current += delta;
      if (timeout.current === null) timeout.current = setTimeout(flush, 33);
    },
    finish() {
      flush();
      const final = open.current;
      if (final) setSections((previous) => [...previous, final]);
      open.current = '';
      boundary.current = freshBoundary();
      if (status.current && status.current.textContent !== 'Response complete') status.current.textContent = 'Response complete';
      if (tailNode.current) tailNode.current.data = '';
    },
    reset() {
      if (timeout.current !== null) clearTimeout(timeout.current);
      timeout.current = null;
      open.current = '';
      pending.current = '';
      boundary.current = freshBoundary();
      if (status.current) status.current.textContent = '';
      if (tailNode.current) tailNode.current.data = '';
      setSections([]);
    },
  }));

  return <div className={className}>
    <div role="status" className="neo-stream-status"><AstryxText><span ref={status} /></AstryxText></div>
    {sections.map((markdown, index) => <Section key={index} markdown={markdown} />)}
    <div ref={tailElement} className="neo-stream-tail" />
  </div>;
});
