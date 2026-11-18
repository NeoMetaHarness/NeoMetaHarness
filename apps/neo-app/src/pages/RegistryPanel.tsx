import { useEffect, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';

type Client = ContractRouterClient<typeof neoContract>;
type Skill = { name: string; version: number; sourceProfile: string; sourcePath: string; trust: string; updatedAt: number };
type Version = { version: number; hash: string; metadata: Skill };
type Assignment = { name: string; engine: 'hermes' | 'dsh'; targetId: string };
const api = createORPCClient<Client>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
})).x['skills-registry'];

export default function RegistryPanel({ profile, profiles }: { profile: string; profiles: string[] }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selected, setSelected] = useState('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [diff, setDiff] = useState('');
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [targetEngine, setTargetEngine] = useState<'hermes' | 'dsh'>('hermes');
  const [targetId, setTargetId] = useState('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    const [items, targets] = await Promise.all([api.list(), api.assignments()]);
    setSkills(items);
    setAssignments(targets);
    return items;
  }
  async function loadVersions(name: string) {
    setSelected(name);
    const result = await api.versions({ name });
    setVersions(result);
    setFrom(result[0]?.version ?? 1);
    setTo(result.at(-1)?.version ?? 1);
    setDiff('');
  }
  useEffect(() => { void refresh().catch((reason) => setError(String(reason))); }, []);
  async function action(task: () => Promise<void>) {
    setError(''); setNotice(''); setBusy(true);
    try { await task(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  const assignment = assignments.some((item) => item.name === selected && item.engine === targetEngine && item.targetId === targetId);

  return <section className="skills-panel skills-registry" data-testid="registry-panel">
    <div className="skills-panel-title"><h2>Neo Skill Registry</h2>
      <Button label="Refresh registry" size="sm" variant="secondary" isDisabled={busy}
        onClick={() => void action(async () => { await refresh(); })}>Refresh</Button></div>
    <p>Versioned local skills. Assign a reviewed skill to another bot or a DSH session.</p>
    {error && <p role="alert" className="page-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <Button label="Sync skills from bot" data-testid="registry-sync" isDisabled={busy}
      onClick={() => void action(async () => {
        const imported = await api.sync({ profile });
        await refresh();
        if (imported.length) await loadVersions(imported[0]!.name);
        setNotice(`${imported.length} skills synced from ${profile}`);
      })}>Sync from {profile}</Button>
    <div className="skills-registry-grid">
      <ul data-testid="registry-list" aria-label="Registry skills">
        {skills.map((item) => <li key={item.name} data-testid={`registry-skill-${item.name}`}>
          <button type="button" className="skills-registry-select" onClick={() => void action(async () => { await loadVersions(item.name); })}>
            <strong>{item.name}</strong> <span>v{item.version} � {item.trust}</span>
          </button>
          <small>Source bot {item.sourceProfile} � {item.sourcePath}</small>
        </li>)}
        {!skills.length && <li>Registry is empty. Sync a learned skill from a bot.</li>}
      </ul>
      {selected && <div data-testid="registry-details">
        <h3>{selected}</h3>
        <p>{versions.length} versions</p>
        <label>From version <select data-testid="registry-from" value={from} onChange={(event) => setFrom(Number(event.target.value))}>
          {versions.map((item) => <option key={item.version} value={item.version}>v{item.version}</option>)}
        </select></label>
        <label>To version <select data-testid="registry-to" value={to} onChange={(event) => setTo(Number(event.target.value))}>
          {versions.map((item) => <option key={item.version} value={item.version}>v{item.version}</option>)}
        </select></label>
        <div className="skills-actions">
          <Button label="Compare versions" data-testid="registry-diff-button" isDisabled={busy}
            onClick={() => void action(async () => { setDiff((await api.diff({ name: selected, from, to })).diff); })}>Diff</Button>
          <Button label="Restore selected version" data-testid="registry-rollback" variant="secondary" isDisabled={busy}
            onClick={() => void action(async () => {
              const result = await api.rollback({ name: selected, version: from });
              await refresh(); await loadVersions(selected);
              setNotice(`Restored v${from} as v${result.version}`);
            })}>Rollback from v{from}</Button>
        </div>
        {diff && <pre data-testid="registry-diff">{diff}</pre>}
        <h3>Assign skill</h3>
        <label>Engine <select data-testid="registry-engine" value={targetEngine}
          onChange={(event) => { const engine = event.target.value as 'hermes' | 'dsh'; setTargetEngine(engine); setTargetId(engine === 'hermes' ? profile : ''); }}>
          <option value="hermes">Hermes bot</option><option value="dsh">DSH session</option>
        </select></label>
        <label>Bot or session ID <input data-testid="registry-target" value={targetId} list="registry-profiles"
          onChange={(event) => setTargetId(event.target.value)} /></label>
        <datalist id="registry-profiles">{profiles.map((name) => <option key={name} value={name} />)}</datalist>
        <Button label={assignment ? 'Unassign skill' : 'Assign skill'} data-testid="registry-assign"
          isDisabled={busy || !targetId.trim()} onClick={() => void action(async () => {
            await api.assign({ name: selected, engine: targetEngine, targetId, assigned: !assignment });
            await refresh(); setNotice(assignment ? 'Skill unassigned' : 'Skill assigned');
          })}>{assignment ? 'Unassign' : 'Assign'}</Button>
      </div>}
    </div>
  </section>;
}
