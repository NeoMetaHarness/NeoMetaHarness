import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from '@astryxdesign/core/Markdown';

export interface StreamViewHandle {
  append(delta: string): void;
  finish(): void;
  reset(): void;
}

const Section = memo(function Section({ markdown }: { markdown: string }) {
  return <Markdown contentWidth="100%">{markdown}</Markdown>;
});

// Complete sections end at blank lines before headings, outside fenced code.
function splitSections(text: string): [string[], string] {
  const sections: string[] = [];
  let from = 0;
  let inFence = false;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('```', i) && (i === 0 || text[i - 1] === '\n')) inFence = !inFence;
    if (!inFence && text.startsWith('\n\n#', i)) {
      sections.push(text.slice(from, i));
      from = i + 2;
    }
  }
  return [sections, text.slice(from)];
}

/** Hot-path deltas update one DOM Text node every ~33ms. Only complete Markdown sections enter React. */
export const StreamView = forwardRef<StreamViewHandle, { className?: string }>(function StreamView({ className }, ref) {
  const [sections, setSections] = useState<string[]>([]);
  const pending = useRef('');
  const open = useRef('');
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
    const [done, tail] = splitSections(open.current + pending.current);
    pending.current = '';
    open.current = tail;
    if (done.length) setSections((previous) => [...previous, ...done]);
    if (tailNode.current) tailNode.current.data = tail;
  };

  useImperativeHandle(ref, () => ({
    append(delta) {
      if (!delta) return;
      pending.current += delta;
      if (timeout.current === null) timeout.current = setTimeout(flush, 33);
    },
    finish() {
      flush();
      if (open.current) setSections((previous) => [...previous, open.current]);
      open.current = '';
      if (tailNode.current) tailNode.current.data = '';
    },
    reset() {
      if (timeout.current !== null) clearTimeout(timeout.current);
      timeout.current = null;
      open.current = '';
      pending.current = '';
      if (tailNode.current) tailNode.current.data = '';
      setSections([]);
    },
  }));

  return <div className={className} aria-live="polite">
    {sections.map((markdown, index) => <Section key={index} markdown={markdown} />)}
    <div ref={tailElement} style={{ whiteSpace: 'pre-wrap' }} />
  </div>;
});
