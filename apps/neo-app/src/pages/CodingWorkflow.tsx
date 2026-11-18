import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';

type Client = ContractRouterClient<typeof neoContract>;
const client = createORPCClient<Client>(new HttpLink({ url: gatewayUrl(),
  headers: () => ({ authorization: `Bearer ${gatewayToken()}` }) }));

/** One optional panel; chat history, diffs and provider selection remain in Coding. */
export default function CodingWorkflow({ threadId }: { threadId: string }) {
  const [branch, setBranch] = useState('');
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState('');
  const [description, setDescription] = useState('');
  const [command, setCommand] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setStatus('');
    if (output.current) output.current.textContent = '';
    return () => { generation.current++; socket.current?.close(); socket.current = null; };
  }, [threadId]);
  const action = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { setStatus(await fn()); }
    catch (error) { setStatus(String(error)); }
    finally { setBusy(false); }
  };
  const append = (text: string, replace = false) => {
    if (!output.current) return;
    // Text-only bounded renderer: terminal deltas never enter React state.
    const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    output.current.textContent = ((replace ? '' : output.current.textContent ?? '') + plain).slice(-262144);
    output.current.scrollTop = output.current.scrollHeight;
  };
  const terminal = async () => {
    socket.current?.close();
    const current = generation.current;
    const opened = await client.x['coding-workflow'].terminal.open({ threadId });
    append((opened.snapshot as { history?: string }).history ?? '', true);
    const ws = new WebSocket(gatewayUrl().replace(/^http/, 'ws') + '/ws', ['bearer.' + gatewayToken()]);
    socket.current = ws;
    const stream = createORPCClient<Client>(new WebSocketLink({ websocket: ws }));
    void (async () => {
      try {
        for await (const item of await stream.x['coding-workflow'].terminal.output({ threadId, terminalId: opened.terminalId })) {
          if (generation.current !== current) return;
          const event = item as { type: string; data?: string; snapshot?: { history?: string } };
          if (event.type === 'snapshot') append(event.snapshot?.history ?? '', true);
          if (event.type === 'output') append(event.data ?? '');
        }
      } catch (error) { if (generation.current === current) setStatus(String(error)); }
      finally { ws.close(); }
    })();
    return 'Terminal connected (read only)';
  };
  return <details data-testid="coding-workflow">
    <summary>Worktree, terminal and prepare PR</summary>
    <div className="coding-actions">
      <Button label="Enable DSH coding provider" isDisabled={busy} data-testid="coding-register"
        onClick={() => void action(async () => { await client.x['coding-workflow'].register(); return 'DSH provider ready: neo-coding'; })}>Enable DSH coding provider</Button>
      <label>New branch <input data-testid="workflow-branch" value={branch} onChange={e => setBranch(e.target.value)} /></label>
      <Button label="Create worktree" isDisabled={busy || !branch.trim()} data-testid="workflow-worktree"
        onClick={() => void action(async () => (await client.x['coding-workflow'].worktree({ threadId, branch })).path)}>Create worktree</Button>
      <Button label="Open terminal output" isDisabled={busy} data-testid="workflow-terminal"
        onClick={() => void action(terminal)}>Open terminal output</Button>
    </div>
    <pre ref={output} data-testid="workflow-output" aria-label="Read-only terminal output" style={{ maxHeight: 240, overflow: 'auto' }} />
    <label>Run command <input data-testid="workflow-command" value={command} onChange={e => setCommand(e.target.value)} /></label>
    <Button label="Run in terminal" isDisabled={busy || !command.trim()} data-testid="workflow-run"
      onClick={() => void action(async () => { await client.x['coding-workflow'].terminal.run({ threadId, command }); return 'Command submitted'; })}>Run in terminal</Button>
    <label>Commit title <input data-testid="workflow-title" value={title} onChange={e => setTitle(e.target.value)} /></label>
    <label>Files to commit (one per line)<textarea data-testid="workflow-files" value={files} onChange={e => setFiles(e.target.value)} /></label>
    <label>PR description<textarea data-testid="workflow-description" value={description} onChange={e => setDescription(e.target.value)} /></label>
    <Button label="Prepare PR locally" isDisabled={busy || !title.trim() || !files.trim()} data-testid="workflow-prepare"
      onClick={() => void action(async () => {
        const result = await client.x['coding-workflow'].prepare({ threadId, title, description,
          files: files.split('\n').map(f => f.trim()).filter(Boolean) });
        return `Prepared ${result.branch} at ${result.commit}; description: ${result.descriptionFile}`;
      })}>Prepare PR locally</Button>
    <p role="status" data-testid="workflow-status">{status}</p>
  </details>;
}
