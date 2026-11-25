import { useCallback, useEffect, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { Badge, Banner, Button, Card, Dialog, DialogHeader, EmptyState, MoreMenu, Selector, Skeleton, TextArea, TextInput } from '@neometaharness/ui';
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
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [refreshError, setRefreshError] = useState('');
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
      setRefreshError('');
    } catch (reason) { setRefreshError('Memory unavailable: ' + String(reason)); } finally { setLoading(false); }
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
      setEditing(null); setEditorOpen(false);
      await refresh(search);
    } catch (reason) { setError('Save failed: ' + String(reason)); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    setError('');
    setDeleteError('');
    try {
      await memory.delete({ id });
      setNotice('Memory deleted'); setDeleting(null);
      await refresh(search);
    } catch (reason) { setDeleteError('Delete failed: ' + String(reason)); }
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

  function openEditor(entry?: Entry) {
    setEditing(entry?.id ?? null);
    setText(entry?.text ?? '');
    setError('');
    setEditorOpen(true);
  }

  return <section className="memory-page" data-testid="memory-page">
    <header className="page-header memory-header">
      <div><h1>Memory</h1><p>Review what your agents remember and where each entry came from.</p>
        <span data-testid="honcho-status" role="status"><Badge label={'Honcho ' + honchoStatus} variant={honchoStatus === 'ok' ? 'success' : honchoStatus === 'degraded' ? 'warning' : 'neutral'} /></span>
      </div>
      <div className="memory-actions">
        <Button label="Export Markdown" data-testid="memory-export" variant="secondary" onClick={() => void download()}>Export Markdown</Button>
        <Button label="Add memory" data-testid="memory-add" onClick={() => openEditor()}>Add memory</Button>
      </div>
    </header>
    {(error || refreshError) && <Banner role="alert" status="error" title={error || refreshError} data-testid="memory-error" />}
    {notice && <Banner role="status" status="success" title={notice} isDismissable onDismiss={() => setNotice('')} />}
    <section className="memory-library">
      <div className="memory-heading"><h2>Library</h2>
        <Selector data-testid="memory-source-filter" label="Source" value={sourceFilter} options={[{value: 'all', label: 'All'}, {value: 'local', label: 'Local'}, {value: 'honcho', label: 'Honcho'}]} onChange={value => setSourceFilter(value as typeof sourceFilter)} />
        <TextInput label="Search" type="search" hasClear data-testid="memory-search" value={search} onChange={setSearch} />
      </div>
      {loading && <div role="status" aria-label="Loading memories"><Skeleton height={72} /></div>}
      <ul data-testid="memory-list">{shown.map(entry =>
        <li key={entry.id} data-testid="memory-entry">
          <Card>
            <div className="memory-record">
              <p>{entry.text}</p>
              {!entry.id.startsWith('nmh:') && <MoreMenu label="Memory actions" data-testid="memory-actions-menu" isDisabled={busy} items={[
                {label: 'Edit', onClick: () => openEditor(entry)},
                {label: 'Delete', variant: 'destructive', onClick: () => { setDeleteError(''); setDeleting(entry); }},
              ]} />}
            </div>
            <div className="memory-meta">
              <Badge label={entry.subject + ' / ' + entry.subject_id} />
              <Badge label={entry.source} /><Badge label={entry.trust} />
              <time dateTime={new Date(entry.updated_at).toISOString()}>{new Date(entry.updated_at).toLocaleString()}</time>
            </div>
            <div className="memory-meta">Provenance: {entry.provenance}</div>
          </Card>
        </li>)}</ul>
      {!loading && !shown.length && !refreshError && <EmptyState title={search || sourceFilter !== 'all' ? 'No matching memories' : 'No memories yet'} description={search || sourceFilter !== 'all' ? 'Try another search or source.' : 'Add a memory to your library.'} actions={search || sourceFilter !== 'all' ? <Button label="Clear filters" variant="secondary" onClick={() => { setSearch(''); setSourceFilter('all'); }}>Clear filters</Button> : <Button label="Add memory" onClick={() => openEditor()}>Add memory</Button>} />}
    </section>
    <Dialog isOpen={editorOpen} purpose="form" width={560} onOpenChange={open => { if (!busy) setEditorOpen(open); }}>
      <DialogHeader title={editing ? 'Edit memory' : 'Add memory'} />
      <form className="memory-editor" onSubmit={event => void save(event)}>
        {error && <Banner status="error" title={error} role="alert" />}
        <TextArea label="Memory text" data-testid="memory-text" value={text} onChange={setText} htmlMaxLength={16000} rows={5} isRequired />
        {!editing && <>
          <Selector label="Subject" value={subject} options={[{value: 'user', label: 'User'}, {value: 'bot', label: 'Bot'}]} onChange={value => setSubject(value as 'user' | 'bot')} />
          <TextInput label="Profile or global" description="Use global for shared memory, or enter a specific profile." value={subjectId} onChange={value => setSubjectId(value.slice(0, 100))} />
        </>}
        <div className="memory-actions">
          <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={() => setEditorOpen(false)}>Cancel</Button>
          <Button type="submit" label={editing ? 'Save changes' : 'Add memory'} data-testid="memory-save" isLoading={busy} isDisabled={busy || !text.trim()}>{editing ? 'Save changes' : 'Add memory'}</Button>
        </div>
      </form>
    </Dialog>
    <Dialog data-testid="memory-delete-dialog" role="alertdialog" aria-describedby="memory-delete-description" isOpen={Boolean(deleting)} purpose="form" width={400} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}>
      <DialogHeader title="Delete memory?" />
      <div className="memory-editor">
        <p id="memory-delete-description">{deleting ? 'Permanently delete this memory: ' + deleting.text.slice(0, 160) : ''}</p>
        {deleteError && <Banner status="error" title={deleteError} role="alert" />}
        <div className="memory-actions">
          <Button label="Cancel" variant="secondary" data-autofocus isDisabled={busy} onClick={() => setDeleting(null)}>Cancel</Button>
          <Button label="Delete memory" variant="destructive" isLoading={busy} isDisabled={busy} onClick={() => { if (deleting) void remove(deleting.id); }}>Delete memory</Button>
        </div>
      </div>
    </Dialog>
  </section>;
}
