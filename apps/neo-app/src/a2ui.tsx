import { useEffect, useState, type ReactNode } from 'react';
import type { ContractRouterClient } from '@orpc/contract';
import type { A2uiActionInput, neoContract, T3Event } from '@neometaharness/contracts';
import { Markdown } from '@neometaharness/ui';
import type { SurfaceMessage } from '../../../extensions/a2ui/src/catalog.js';

type Client = ContractRouterClient<typeof neoContract>;
type Renderer = typeof import('../../../extensions/a2ui/src/render.js')['default'];
export type ReplySegment = { kind: 'text'; text: string } | {
  kind: 'surface'; message: SurfaceMessage; actions: Record<string, { handle: string; fields: Record<string, string> }>;
};

export function replySegments(event: T3Event): ReplySegment[] | undefined {
  if (event.type === 'a2ui.message' && Array.isArray(event.payload)) return event.payload as ReplySegment[];
}

export function useInteractiveReplies(client: Client) {
  const [availability, setAvailability] = useState({ enabled: false, generation: 0 });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const rows = await client.extensions.list().catch(() => []);
      if (stopped) return;
      const enabled = rows.some((row) => row.id === 'a2ui' && row.status === 'running');
      setAvailability((previous) => enabled === previous.enabled ? previous :
        { enabled, generation: previous.generation + 1 });
      timer = setTimeout(() => void refresh(), 1500);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [client]);
  return availability;
}

export function InteractiveReply({ segments, children, isBusy, onAction }: {
  segments?: ReplySegment[];
  children: ReactNode;
  isBusy?: boolean;
  onAction: (input: A2uiActionInput) => Promise<void>;
}) {
  const [renderer, setRenderer] = useState<Renderer>();
  const needed = Boolean(segments);
  useEffect(() => {
    if (!needed) return;
    let current = true;
    void import('../../../extensions/a2ui/src/render.js').then(({ default: next }) => {
      if (current) setRenderer(() => next);
    }).catch(() => {});
    return () => { current = false; };
  }, [needed]);
  const WidgetSurface = renderer;
  return <>
    <div hidden={Boolean(segments && WidgetSurface)}>{children}</div>
    {WidgetSurface && segments?.map((segment, index) => segment.kind === 'text'
      ? <Markdown key={index} contentWidth="100%">{segment.text}</Markdown>
      : <WidgetSurface key={segment.message.createSurface.surfaceId} message={segment.message} actions={segment.actions}
          isBusy={isBusy} onAction={onAction} fallback={<pre>{JSON.stringify(segment.message, null, 2)}</pre>} />)}
  </>;
}
