import { useEffect, useRef, useState } from 'react';
import { Button, Card, Heading, TextInput, TextArea, Selector } from '@neometaharness/ui';
import { engineDisabled, hermesRpc } from './hermes-work';
import './hermes-work.css';

type Board = Record<string, unknown>;
type Task = Record<string, unknown>;
type Column = { name: string; tasks: Task[] };
type BoardView = { columns: Column[]; assignees: string[] };

export default function Tasks() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [boardName, setBoardName] = useState('');
  const [slug, setSlug] = useState('');
  const [view, setView] = useState<BoardView | null>(null);
  const [bots, setBots] = useState<string[]>(['default']);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('default');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading');
  const [error, setError] = useState('');
  const active = useRef(true);
  const selectedBoard = useRef(workspace);

  useEffect(() => {
    active.current = true;
    void hermesRpc.x['engine-hermes'].profiles.list().then((result) => {
      if (active.current) setBots([...new Set(['default', ...result.profiles.map((profile) => profile.name)])]);
    }).catch(() => {});
    void loadBoards();
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    selectedBoard.current = workspace;
    setView(null);
    if (!workspace) return;
    void loadBoard(workspace);
    const timer = window.setInterval(() => void loadBoard(workspace, true), 1500);
    return () => window.clearInterval(timer);
  }, [workspace]);

  async function loadBoards() {
    try {
      const result = await hermesRpc.x['engine-hermes'].kanban.boards();
      if (!active.current) return;
      setBoards(result.boards);
      setWorkspace((previous) => previous || result.current || String(result.boards[0]?.slug ?? ''));
      setStatus('Ready');
    } catch (reason) {
      if (!active.current) return;
      if (engineDisabled(reason)) setStatus('disabled');
      else setError(`Could not load workspace boards: ${String(reason)}`);
    }
  }

  async function loadBoard(board: string, quiet = false) {
    try {
      const result = await hermesRpc.x['engine-hermes'].kanban.board({ workspace: board });
      if (!active.current || selectedBoard.current !== board) return;
      setView(result);
      setStatus('Ready');
      if (!quiet) setError('');
    } catch (reason) {
      if (!active.current || selectedBoard.current !== board) return;
      if (engineDisabled(reason)) setStatus('disabled');
      else if (!quiet) setError(`Could not load board: ${String(reason)}`);
    }
  }

  async function createBoard(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slug.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await hermesRpc.x['engine-hermes'].kanban.createBoard({ slug: slug.trim(), name: boardName.trim() });
      await loadBoards();
      setWorkspace(slug.trim());
      setSlug(''); setBoardName('');
    } catch (reason) {
      setError(engineDisabled(reason) ? 'Hermes engine disabled' : `Could not create board: ${String(reason)}`);
      if (engineDisabled(reason)) setStatus('disabled');
    } finally { setBusy(false); }
  }

  async function createTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await hermesRpc.x['engine-hermes'].kanban.create({ workspace, title: title.trim(), body, assignee });
      setTitle(''); setBody('');
      await loadBoard(workspace);
    } catch (reason) {
      setError(engineDisabled(reason) ? 'Hermes engine disabled' : `Could not create task: ${String(reason)}`);
      if (engineDisabled(reason)) setStatus('disabled');
    } finally { setBusy(false); }
  }

  async function assign(id: string, bot: string) {
    if (!workspace || busy) return;
    setBusy(true); setError('');
    try {
      await hermesRpc.x['engine-hermes'].kanban.assign({ workspace, id, assignee: bot });
      await loadBoard(workspace);
    } catch (reason) { setError(`Could not assign task: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function dispatch() {
    if (!workspace || busy) return;
    setBusy(true); setError('');
    try {
      await hermesRpc.x['engine-hermes'].kanban.dispatch({ workspace });
      await loadBoard(workspace);
    } catch (reason) { setError(`Could not dispatch tasks: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  return <section className="hermes-work" data-testid="tasks-page">
    <header className="page-header"><div><h1>Tasks</h1><p>Track work assigned to bots across workspaces.</p></div></header>
    <p role="status" data-testid="tasks-status">{status === 'disabled' ? 'Hermes engine disabled' : status}</p>
    {error && <p className="page-error" role="alert">{error}</p>}
    {status !== 'disabled' && <>
      <div className="work-toolbar"><Selector label="Workspace" id="tasks-workspace" htmlName="tasks-workspace" value={workspace} onChange={setWorkspace} isDisabled={busy} options={boards.map(board => ({ value: String(board.slug), label: String(board.name || board.slug) }))} />
        <Button label="Run assigned tasks" data-testid="tasks-dispatch" isDisabled={!workspace || busy} onClick={() => void dispatch()}>Run assigned tasks</Button>
      </div>
      <form className="work-toolbar" onSubmit={(event) => void createBoard(event)}>
        <TextInput label="New workspace" id="tasks-slug" placeholder="workspace-id" value={slug} onChange={setSlug} ref={el => { if (el) { el.dataset.testid = "tasks-slug"; el.pattern = "[a-z0-9][a-z0-9_-]*"; el.maxLength = 64; } }} />
        <TextInput label="Workspace name" placeholder="Display name" value={boardName} onChange={setBoardName} />
        <Button label="Create workspace" data-testid="tasks-create-board" type="submit" isDisabled={busy || !slug.trim()}>Create workspace</Button>
      </form>
      {workspace && <>
        <form className="work-form work-task-form" onSubmit={(event) => void createTask(event)}>
          <Heading level={2}>New task</Heading>
          <TextInput label="Title" id="tasks-title" ref={el => { if (el) el.dataset.testid = "tasks-title"; }} value={title} onChange={setTitle} isRequired />
          <TextArea label="Instructions" id="tasks-body" ref={el => { if (el) el.dataset.testid = "tasks-body"; }} value={body} onChange={setBody} rows={3} />
          <Selector label="Assign to bot" id="tasks-assignee" htmlName="tasks-assignee" value={assignee} onChange={setAssignee} options={bots.map(bot => ({ value: bot, label: bot }))} />
          <Button label="Create task" data-testid="tasks-create" type="submit" isDisabled={busy || !title.trim()}>Create task</Button>
        </form>
        <div className="work-columns" data-testid="tasks-board">
          {view?.columns.map((column) => <section className="work-column" key={column.name} data-testid={`tasks-column-${column.name}`}>
            <h2>{column.name} <span>{column.tasks.length}</span></h2>
            {column.tasks.map((task) => <Card className="work-card" data-testid="tasks-card" key={String(task.id)}>
              <Heading level={3}>{String(task.title ?? '')}</Heading>
              <p>{String(task.status ?? column.name)}</p>
              {Boolean(task.latest_summary) && <p>{String(task.latest_summary)}</p>}
              <Selector label="Assigned bot" value={String(task.assignee ?? '')} isDisabled={busy}
                onChange={value => void assign(String(task.id), value)} options={[
                  ...(!task.assignee || !bots.includes(String(task.assignee)) ? [{ value: '', label: 'Unassigned' }] : []),
                  ...bots.map(bot => ({ value: bot, label: bot })),
                ]} />
            </Card>)}
          </section>)}
        </div>
      </>}
    </>}
  </section>;
}
