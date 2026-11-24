import { createElement, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { renderMarkdown } from '@a2ui/markdown-it';
import { Banner, Button, CheckboxInput, Heading, Text, TextInput, VStack } from '@neometaharness/ui';
import type { A2uiActionInput } from '@neometaharness/contracts';
import { maxInputLength, type FieldValue, type SurfaceMessage, type Widget } from './catalog.js';
import { openSurface } from './render-model.js';
import './render.css';

const markdownTags = new Set(['p', 'strong', 'em', 's', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'br']);
const droppedTags = new Set(['img', 'video', 'audio', 'source', 'iframe', 'script', 'style', 'svg', 'math']);

function safeMarkdown(html: string): ReactNode {
  // Template contents stay inert. Recreate the allowed elements without any source attributes.
  const template = document.createElement('template');
  template.innerHTML = html;
  function children(parent: ParentNode): ReactNode {
    return Array.from(parent.childNodes, (node, key) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (!(node instanceof HTMLElement)) return null;
      const tag = node.localName;
      if (droppedTags.has(tag)) return null;
      return markdownTags.has(tag) ? createElement(tag, { key }, children(node)) : children(node);
    });
  }
  return children(template.content);
}

function MarkdownText({ text }: { text: string }) {
  const [content, setContent] = useState<{ text: string; nodes: ReactNode }>();
  useEffect(() => {
    let active = true;
    void renderMarkdown(text).then((html) => {
      if (active) setContent({ text, nodes: safeMarkdown(html) });
    }).catch(() => {});
    return () => { active = false; };
  }, [text]);
  return <Text as="div">{content?.text === text ? content.nodes : text}</Text>;
}

type SurfaceView = ReturnType<typeof openSurface>['surface'];
type RendererProps = {
  message: SurfaceMessage;
  actions: Record<string, { handle: string; fields: Record<string, string> }>;
  isBusy?: boolean;
  onAction: (input: A2uiActionInput) => Promise<void>;
  fallback: ReactNode;
};

export default function A2uiSurface({ message, actions, isBusy, onAction, fallback }: RendererProps) {
  const [current, setCurrent] = useState<{ message: SurfaceMessage; model?: SurfaceView }>();
  useEffect(() => {
    try {
      const opened = openSurface(message);
      setCurrent({ message, model: opened.surface });
      return opened.dispose;
    } catch {
      setCurrent({ message });
    }
  }, [message]);
  if (current?.message !== message || !current.model) return fallback;
  return <SurfaceForm key={message.createSurface.surfaceId} surface={current.model}
    actions={actions} isBusy={isBusy} onAction={onAction} />;
}

function SurfaceForm({ surface, actions, isBusy, onAction }: Pick<RendererProps, 'actions' | 'isBusy' | 'onAction'> & {
  surface: SurfaceView;
}) {
  const pending = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const [working, setWorking] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  const [fields, setFields] = useState<Record<string, FieldValue>>({});
  const disabled = Boolean(isBusy || working || sent || Object.keys(actions).length === 0);

  function edit(path: string, value: FieldValue) {
    surface.dataModel.set(path, value);
    setFields((previous) => ({ ...previous, [path]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const button = (event.nativeEvent as SubmitEvent).submitter;
    const id = button instanceof HTMLButtonElement ? button.value : undefined;
    const action = id && Object.hasOwn(actions, id) ? actions[id] : undefined;
    if (!action || disabled || pending.current) return;
    pending.current = true;
    setWorking(true);
    setError(false);
    try {
      const idempotencyKey = attempts.current.get(action.handle) ?? crypto.randomUUID();
      attempts.current.set(action.handle, idempotencyKey);
      await onAction({ handle: action.handle, idempotencyKey, fields:
        Object.fromEntries(Object.entries(action.fields).map(([key, path]) => [key, surface.dataModel.get<FieldValue>(path)])) });
      setSent(true);
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setWorking(false);
    }
  }

  function renderWidget(id: string): ReactNode {
    const node = surface.componentsModel.get(id);
    if (!node) return null;
    const widget = node.componentTree as Widget;
    switch (widget.component) {
      case 'Text': return <MarkdownText key={id} text={widget.text} />;
      case 'Heading': return <Heading key={id} level={4}>{widget.text}</Heading>;
      case 'Column': return <VStack key={id}>{widget.children.map(renderWidget)}</VStack>;
      case 'Button': {
        const label = surface.componentsModel.get(widget.child)?.componentTree as Widget | undefined;
        return label?.component === 'Text' && <Button key={id} type="submit" value={id} label={label.text}
          isDisabled={disabled || !Object.hasOwn(actions, id)} />;
      }
      case 'CheckBox': {
        const path = widget.value['@path'];
        return <CheckboxInput key={id} label={widget.label} isDisabled={disabled}
          value={Boolean(fields[path] ?? surface.dataModel.get(path))} onChange={(value) => edit(path, value)} />;
      }
      case 'TextField': {
        const path = widget.value['@path'];
        return <TextInput key={id} label={widget.label} isDisabled={disabled}
          value={String(fields[path] ?? surface.dataModel.get(path) ?? '')}
          onChange={(value) => edit(path, value.slice(0, maxInputLength))} />;
      }
    }
  }

  return <form className="neo-a2ui-surface" onSubmit={(event) => void submit(event)}>
    {renderWidget('root')}
    {error && <Banner status="error" title="The action could not be sent." />}
  </form>;
}
