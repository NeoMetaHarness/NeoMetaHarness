import { useCallback, useEffect, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';
import './memory.css';

type Client = ContractRouterClient<typeof neoContract>;
type Entry = Awaited<ReturnType<Client['x']['memory-local']['list']>>[number];
const rpc = createORPCClient<Client>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));
const memory = rpc.x['memory-local'];
const honcho = rpc.x['memory-honcho'];
const workspace = 'default';

export default function Memory() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [honchoEntries, setHonchoEntries] = useState<Entry[]>([]);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'local' | 'honcho'>('all');
  const [honchoStatus, setHonchoStatus] = useState<'ok' | 'degraded' | 'off'>('off');
  const [search, setSearch] = useState('');
  const [text, setText] = useState('');
  const [subject, setSubject] = useState<'user' | 'bot'>('user');
  const [subjectId, setSubjectId] = useState('global');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async (query = '') => {
    try {
      const found = await memory.list({ workspace, query });
      setEntries(found);
      try {
        const status = await honcho.status({ workspace });
        setHonchoStatus(status);
        if (status === 'ok') {
          setHonchoEntries(await honcho.list({ workspace, query }));
        } else {
          setHonchoEntries([]);
        }
      } catch {
        setHonchoStatus('degraded');
        setHonchoEntries([]);
      }
      setError('');
    } catch (reason) { setError('Memory unavailable: ' + String(reason)); }
  }, []);

  useEffect(() => {
    void refresh(search);
    const timer = window.setInterval(() => { void refresh(search); }, 1500);
    return () => window.clearInterval(timer);
  }, [refresh, search]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      if (editing) {
        await memory.update({ id: editing, text: text.trim() });
        setNotice('Memory updated');
      } else {
        await memory.add({ workspace, subject, subjectId: subjectId.trim() || 'global',
          text: text.trim(), source: 'manual', provenance: 'Neo Memory UI', trust: 'confirmed' });
        setNotice('Memory saved');
      }
      setText('');
      setEditing(null);
      await refresh(search);
    } catch (reason) { setError('Save failed: ' + String(reason)); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    setError('');
    try {
      await memory.delete({ id });
      setNotice('Memory deleted');
      await refresh(search);
    } catch (reason) { setError('Delete failed: ' + String(reason)); }
    finally { setBusy(false); }
  }

  async function download() {
    setError('');
    try {
      const documents = await memory.export({ workspace });
      for (const [filename, content] of Object.entries(documents)) {
        const objectUrl = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
      setNotice('Exported SOUL.md, USER.md and MEMORY.md');
    } catch (reason) { setError('Export failed: ' + String(reason)); }
  }

  const shown = sourceFilter === 'local' ? entries
    : sourceFilter === 'honcho' ? honchoEntries : [...entries, ...honchoEntries];

  return <section className="memory-page" data-testid="memory-page">
    <header className="page-header memory-header">
      <div><h1>Memory</h1><p>Review what your agents remember and where each entry came from.</p>
        <span data-testid="honcho-status" className={'honcho-status honcho-' + honchoStatus}
          role="status">Honcho {honchoStatus}</span>
      </div>
      <Button label="Export Markdown" data-testid="memory-export" variant="secondary"
        onClick={() => void download()}>Export Markdown</Button>
    </header>
    {error && <p role="alert" className="page-error" data-testid="memory-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <form className="memory-editor" onSubmit={(event) => void save(event)}>
      <h2>{editing ? 'Edit memory' : 'Add memory'}</h2>
      <label htmlFor="memory-text">Memory text</label>
      <textarea id="memory-text" data-testid="memory-text" value={text}
        onChange={(event) => setText(event.target.value)} maxLength={16000} required />
      {!editing && <div className="memory-fields">
        <label>Subject <select data-testid="memory-subject" value={subject}
          onChange={(event) => setSubject(event.target.value as 'user' | 'bot')}>
          <option value="user">User</option><option value="bot">Bot</option>
        </select></label>
        <label>Profile or global <input data-testid="memory-subject-id" value={subjectId}
          onChange={(event) => setSubjectId(event.target.value)} maxLength={100} /></label>
      </div>}
      <div className="memory-actions">
        <Button type="submit" label={editing ? 'Save changes' : 'Add memory'} data-testid="memory-save"
          isDisabled={busy || !text.trim()}>{editing ? 'Save changes' : 'Add memory'}</Button>
        {editing && <Button label="Cancel edit" variant="secondary" onClick={() => {
          setEditing(null); setText('');
        }}>Cancel</Button>}
      </div>
    </form>
    <section className="memory-library">
      <div className="memory-heading"><h2>Library</h2>
        <label>Source <select data-testid="memory-source-filter" value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value as 'all' | 'local' | 'honcho')}>
          <option value="all">All</option><option value="local">Local</option>
          <option value="honcho">Honcho</option>
        </select></label>
        <label>Search <input data-testid="memory-search" value={search}
          onChange={(event) => { setSearch(event.target.value); void refresh(event.target.value); }} /></label>
      </div>
      <ul data-testid="memory-list">{shown.map((entry) =>
        <li key={entry.id} data-testid="memory-entry" className="memory-entry">
          <p>{entry.text}</p>
          <div className="memory-meta">
            <span>{entry.subject} / {entry.subject_id}</span>
            <span>{entry.source}</span><span>{entry.trust}</span>
            <span>Provenance: {entry.provenance}</span>
            <time dateTime={new Date(entry.updated_at).toISOString()}>{new Date(entry.updated_at).toLocaleString()}</time>
          </div>
          {!entry.id.startsWith('nmh:') && <div className="memory-actions">
            <Button label="Edit" size="sm" variant="secondary" isDisabled={busy}
              onClick={() => { setEditing(entry.id); setText(entry.text); }}>Edit</Button>
            <Button label="Delete" size="sm" variant="secondary" isDisabled={busy}
              onClick={() => void remove(entry.id)}>Delete</Button>
          </div>}
        </li>)}</ul>
      {!shown.length && !error && <p>No memories found.</p>}
    </section>
  </section>;
}