import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { Button, StreamView, type StreamViewHandle } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';
import './skills.css';
import RegistryPanel from './RegistryPanel';

type Client = ContractRouterClient<typeof neoContract>;
type Skill = { name: string; provenance?: string; usage?: number; category?: string; enabled?: boolean };
type HubSkill = { name: string; identifier?: string; category?: string; installed?: boolean };
type HubReport = {
  id: string; blocked: boolean; approved?: boolean; files: string[];
  findings: { file: string; line: number; category: string; description: string }[];
};
type Curator = { enabled: boolean; paused: boolean; last_run_at?: string | null };
type Graph = { nodes: { id: string; label: string; kind: string }[]; edges: { source: string; target: string }[] };

const http = createORPCClient<Client>(new HttpLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));
const terminal = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);

export default function Skills() {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState('default');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [hub, setHub] = useState<HubSkill[]>([]);
  const [hubReports, setHubReports] = useState<Record<string, HubReport>>({});
  const [hubImported, setHubImported] = useState<string[]>([]);
  const [hubApprovalReason, setHubApprovalReason] = useState('');
  const [curator, setCurator] = useState<Curator | null>(null);
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [learning, setLearning] = useState(false);
  const [runStatus, setRunStatus] = useState('');
  const [streamKey, setStreamKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'library' | 'registry'>('library');
  const [error, setError] = useState('');
  const selected = useRef(profile);
  const mounted = useRef(true);
  const stream = useRef<StreamViewHandle | null>(null);
  const queued = useRef('');
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    mounted.current = true;
    void http.x['engine-hermes'].profiles.list().then((result) => {
      if (mounted.current) setProfiles(result.profiles.map(({ name }) => name));
    }).catch((reason) => { if (mounted.current) setError(`Profiles unavailable: ${String(reason)}`); });
    return () => { mounted.current = false; socket.current?.close(); };
  }, []);

  useEffect(() => {
    selected.current = profile;
    void refresh(profile);
  }, [profile]);

  async function refresh(name: string) {
    setLoading(true);
    setError('');
    try {
      const [library, catalog, state, learningGraph] = await Promise.all([
        http.x['engine-hermes'].skills.list({ profile: name }),
        http.x['engine-hermes'].skills.hub({ profile: name }),
        http.x['engine-hermes'].skills.curator({ profile: name }),
        http.x['engine-hermes'].skills.graph({ profile: name }),
      ]);
      if (!mounted.current || selected.current !== name) return;
      setSkills(library);
      setHub(catalog.skills);
      setCurator(state);
      setGraph(learningGraph);
    } catch (reason) {
      if (mounted.current && selected.current === name) setError(`Skills unavailable: ${String(reason)}`);
    } finally {
      if (mounted.current && selected.current === name) setLoading(false);
    }
  }

  async function scanHub(identifier: string) {
    setBusy(true);
    setError('');
    try {
      const report = await http.x['skills-registry'].hub.scan({ profile, identifier });
      setHubReports((previous) => ({ ...previous, [identifier]: report }));
      setNotice(report.blocked ? 'Hub scan found potential risks' : 'Hub scan passed');
    } catch (reason) { setError(`Hub scan failed: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function approveHub(identifier: string) {
    const report = hubReports[identifier];
    if (!report) return;
    setBusy(true);
    setError('');
    try {
      const approved = await http.x['skills-registry'].hub.approve({ id: report.id, reason: hubApprovalReason.trim() });
      setHubReports((previous) => ({ ...previous, [identifier]: approved }));
      setNotice('Hub scan approved by administrator');
    } catch (reason) { setError(`Hub approval failed: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function installHub(identifier: string) {
    const report = hubReports[identifier];
    if (!report) return;
    setBusy(true);
    setError('');
    try {
      const installed = await http.x['skills-registry'].hub.install({ profile, identifier, reportId: report.id });
      setHubImported((previous) => [...previous, identifier]);
      setNotice(`Imported ${installed.name} into Registry. Evaluate this version before assignment.`);
    } catch (reason) { setError(`Hub install failed: ${String(reason)}`); }
    finally { setBusy(false); }
  }

  async function changeCurator(paused: boolean) {
    setBusy(true);
    setError('');
    try {
      const result = await http.x['engine-hermes'].skills.pause({ profile, paused });
      if (mounted.current) {
        setCurator((previous) => previous && { ...previous, paused: result.paused });
        setNotice(result.paused ? 'Curator paused' : 'Curator resumed');
      }
    } catch (reason) {
      setError(`Curator update failed: ${String(reason)}`);
    } finally { setBusy(false); }
  }

  async function runCurator() {
    setBusy(true);
    setError('');
    try {
      await http.x['engine-hermes'].skills.run({ profile });
      setNotice('Curator review started');
      await refresh(profile);
    } catch (reason) {
      setError(`Curator run failed: ${String(reason)}`);
    } finally { setBusy(false); }
  }

  function attachStream(view: StreamViewHandle | null) {
    stream.current = view;
    if (view && queued.current) { view.append(queued.current); queued.current = ''; }
  }

  function appendText(delta: string) {
    const view = stream.current;
    if (view) view.append(delta);
    else queued.current += delta;
  }

  function finishText() { stream.current?.finish(); }

  async function learn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (learning || !description.trim()) return;
    setLearning(true);
    setError('');
    setNotice('');
    setRunStatus('Learning');
    setStreamKey((key) => key + 1);
    stream.current = null;
    queued.current = '';
    const name = profile;
    try {
      const { run_id } = await http.x['engine-hermes'].skills.learn({ profile: name, description: description.trim() });
      const token = gatewayToken();
      const wsSocket = new WebSocket(gatewayUrl().replace(/^http/, 'ws') + '/ws', token ? ['bearer.' + token] : undefined);
      socket.current = wsSocket;
      const ws = createORPCClient<Client>(new WebSocketLink({ websocket: wsSocket }));
      for await (const message of await ws.x['engine-hermes'].runs.events({ profile: name, runId: run_id })) {
        if (message.kind === 'text.delta') {
          appendText(message.textDelta ?? '');
          continue;
        }
        if (terminal.has(message.type ?? '')) {
          setRunStatus(message.type === 'run.completed' ? 'Completed' : 'Failed');
          break;
        }
      }
      if (mounted.current) await refresh(name);
    } catch (reason) {
      setRunStatus('Failed');
      setError(`Learning failed: ${String(reason)}`);
    } finally {
      finishText();
      socket.current?.close();
      socket.current = null;
      if (mounted.current) setLearning(false);
    }
  }

  return <section className="skills-page" data-testid="skills-page">
    <header className="page-header skills-header">
      <div><h1>Skills</h1><p>Learn reusable workflows and inspect what your agents know.</p></div>
      <label>Bot <select data-testid="skills-profile" value={profile} disabled={learning}
        onChange={(event) => setProfile(event.target.value)}>
        {[...new Set(['default', ...profiles])].map((name) => <option key={name} value={name}>{name}</option>)}
      </select></label>
    </header>
    {error && <p className="page-error" role="alert">{error}</p>}
    {notice && <p role="status" className="skills-notice">{notice}</p>}
    <nav className="skills-tabs" aria-label="Skills views">
      <button type="button" data-testid="library-tab" aria-current={tab === 'library' ? 'page' : undefined}
        onClick={() => setTab('library')}>Library</button>
      <button type="button" data-testid="registry-tab" aria-current={tab === 'registry' ? 'page' : undefined}
        onClick={() => setTab('registry')}>Registry</button>
    </nav>
    {tab === 'registry' && <RegistryPanel profile={profile} profiles={[...new Set(['default', ...profiles])]} />}
    <div hidden={tab !== 'library'}>
    <section className="skills-learn skills-panel">
      <h2>Learn a skill</h2>
      <form onSubmit={(event) => void learn(event)}>
        <label htmlFor="learn-description">Describe a task or a workflow worth keeping</label>
        <textarea id="learn-description" data-testid="learn-description" value={description}
          onChange={(event) => setDescription(event.target.value)} placeholder="Turn our last workflow into a reusable skill" />
        <Button label="Learn" data-testid="learn-submit" type="submit" isDisabled={learning || !description.trim()}>Learn</Button>
      </form>
      <p data-testid="learn-status" role="status">{runStatus}</p>
      <StreamView key={streamKey} className="skills-stream" ref={attachStream} />
    </section>
    <div className="skills-grid">
      <section className="skills-panel" data-testid="skills-library">
        <div className="skills-panel-title"><h2>Library</h2><Button label="Refresh" size="sm" variant="secondary"
          onClick={() => void refresh(profile)} isDisabled={loading || learning}>Refresh</Button></div>
        {loading ? <p>Loading skills…</p> : skills.length === 0 ? <p>No skills yet. Teach this agent a workflow.</p> :
          <ul>{skills.map((item) => <li key={item.name} data-testid={`skill-${item.name}`}>
            <strong>{item.name}</strong><span>{item.category ?? 'general'} · {item.provenance ?? 'unknown'} · {item.usage ?? 0} uses</span>
          </li>)}</ul>}
      </section>
      <section className="skills-panel" data-testid="skills-curator">
        <h2>Curator</h2>
        <p data-testid="curator-state">{curator ? curator.paused ? 'Paused' : curator.enabled ? 'Active' : 'Disabled' : 'Loading'}</p>
        <div className="skills-actions">
          <Button label={curator?.paused ? 'Resume' : 'Pause'} data-testid="curator-pause" isDisabled={!curator || busy || learning}
            onClick={() => void changeCurator(!curator?.paused)}>{curator?.paused ? 'Resume' : 'Pause'}</Button>
          <Button label="Run now" data-testid="curator-run" variant="secondary" isDisabled={!curator || busy || learning}
            onClick={() => void runCurator()}>Run now</Button>
        </div>
        {curator?.last_run_at && <p>Last review {curator.last_run_at}</p>}
      </section>
      <section className="skills-panel" data-testid="skills-graph">
        <h2>Learning graph</h2>
        <p data-testid="graph-count">{graph.nodes.length} nodes · {graph.edges.length} connections</p>
        <ul>{graph.nodes.map((node) => <li key={node.id}>
          <strong>{node.label}</strong><span>{node.kind}</span>
        </li>)}</ul>
        {graph.edges.length > 0 && <ul aria-label="Connections">{graph.edges.map((edge, index) =>
          <li key={`${edge.source}-${edge.target}-${index}`}>{edge.source} → {edge.target}</li>)}</ul>}
      </section>
      <section className="skills-panel" data-testid="skills-hub">
        <h2>Skills Hub</h2><p>Official catalog</p>
        {hub.length === 0 && !loading ? <p>No catalog entries available.</p> : <ul>{hub.map((item) => {
          const identifier = item.identifier ?? item.name;
          const report = hubReports[identifier];
          const installed = hubImported.includes(identifier);
          return <li key={identifier} data-testid={`hub-${identifier}`}>
            <strong>{item.name}</strong><span>{item.category ?? 'general'}</span>
            <Button label="Scan" variant="secondary" size="sm" isDisabled={busy || loading}
              data-testid={`hub-scan-${identifier}`} onClick={() => void scanHub(identifier)}>Scan</Button>
            {report && <div className="hub-scan-report" data-testid={`hub-report-${identifier}`}>
              <p role="status">{report.blocked ? report.approved ? 'Approved by admin' : 'Blocked by scan' : 'Scan passed'}
                {' ? '}{report.files.length} files</p>
              {report.findings.length > 0 && <ul>{report.findings.map((finding, index) =>
                <li key={index}>{finding.file}:{finding.line} ? {finding.category} ? {finding.description}</li>
              )}</ul>}
              {report.blocked && !report.approved && <div>
                <label>Admin approval reason
                  <input value={hubApprovalReason} onChange={(event) => setHubApprovalReason(event.target.value)} />
                </label>
                <Button label="Approve scan" size="sm" isDisabled={busy || !hubApprovalReason.trim()}
                  data-testid={`hub-approve-${identifier}`} onClick={() => void approveHub(identifier)}>Approve scan</Button>
              </div>}
              <Button label={installed ? 'Imported' : 'Install in Registry'} size="sm" isDisabled={busy || installed || (report.blocked && !report.approved)}
                data-testid={`hub-install-${identifier}`} onClick={() => void installHub(identifier)}>
                {installed ? 'Imported' : 'Install in Registry'}</Button>
            </div>}
          </li>;
        })}</ul>}
      </section>
    </div>
    </div>
  </section>;
}
