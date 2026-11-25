import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink as HttpLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { Banner, Badge, Button, Card, Collapsible, Dialog, DialogHeader, EmptyState, Section, Selector, Skeleton, StreamView, Tab, TabList, Table, TextArea, TextInput, Timestamp, type StreamViewHandle } from '@neometaharness/ui';
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
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [curator, setCurator] = useState<Curator | null>(null);
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [description, setDescription] = useState('');
  const [learnOpen, setLearnOpen] = useState(false);
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

  function changeProfile(name: string) {
    if (name === profile || busy || learning) return;
    selected.current = name;
    setSkills([]);
    setHub([]);
    setHubReports({});
    setHubImported([]);
    setCurator(null);
    setGraph({ nodes: [], edges: [] });
    setDescription('');
    setRunStatus('');
    setNotice('');
    setStreamKey(key => key + 1);
    queued.current = '';
    setProfile(name);
  }

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
      setReviewing(null);
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
    setLearnOpen(false);
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
      <Selector label="Bot" data-testid="skills-profile" value={profile}
        isDisabled={learning || busy} options={[...new Set(['default', ...profiles])].map(name => ({ value: name, label: name }))}
        onChange={changeProfile} />
    </header>
    {error && <Banner status="error" title={error} role="alert" />}
    {notice && <Banner status="success" title={notice} role="status" />}
    <div className="skills-tabbar">
      <TabList role="tablist" aria-label="Skills views" value={tab} onChange={value => setTab(value as typeof tab)}>
        <Tab value="library" label="Library" id="skills-library-tab" panelId="skills-library-panel" data-testid="library-tab" />
        <Tab value="registry" label="Registry" id="skills-registry-tab" panelId="skills-registry-panel" data-testid="registry-tab" />
      </TabList>
    </div>
    <div role="tabpanel" id="skills-registry-panel" aria-labelledby="skills-registry-tab" hidden={tab !== 'registry'}>
      {tab === 'registry' && <RegistryPanel profile={profile} profiles={[...new Set(['default', ...profiles])]} />}
    </div>
    <div role="tabpanel" id="skills-library-panel" aria-labelledby="skills-library-tab" hidden={tab !== 'library'}>
      <Section variant="transparent" padding={0} className="skills-library-section" data-testid="skills-library">
        <div className="skills-panel-title">
          <h2>Library</h2>
          <div className="skills-actions">
            <Button label="Refresh" size="sm" variant="secondary" isDisabled={loading || learning || busy}
              onClick={() => void refresh(profile)}>Refresh</Button>
            <Button label="Learn a skill" data-testid="learn-open" isDisabled={learning || busy}
              isLoading={learning} onClick={() => { setError(''); setLearnOpen(true); }}>Learn a skill</Button>
          </div>
        </div>
        {loading ? <div role="status" aria-label="Loading skills"><Skeleton height={72} /></div> :
          skills.length === 0 ? <EmptyState title="No skills yet" description="Teach this agent a reusable workflow." /> :
          <div className="skills-library-cards">{skills.map(item => <Card key={item.name} data-testid={'skill-' + item.name}>
            <strong className="skills-name">{item.name}</strong>
            <div className="skills-meta"><Badge label={item.category ?? 'general'} /><span>{item.provenance ?? 'unknown'}</span><span>{item.usage ?? 0} uses</span></div>
          </Card>)}</div>}
        <div hidden={!runStatus} className="skills-learning-result">
          <Card>
            <div className="skills-panel-title"><h3>Learning run</h3><span data-testid="learn-status" role="status"><Badge label={runStatus} variant={runStatus === 'Completed' ? 'success' : runStatus === 'Failed' ? 'error' : 'neutral'} /></span></div>
            <StreamView key={streamKey} className="skills-stream" ref={attachStream} />
          </Card>
        </div>
      </Section>
      <div className="skills-management-grid">
        <Card className="skills-management-card" data-testid="skills-curator">
          <h2>Curator</h2>
          <p data-testid="curator-state"><Badge label={curator ? curator.paused ? 'Paused' : curator.enabled ? 'Active' : 'Disabled' : 'Loading'} variant={curator?.paused ? 'warning' : curator?.enabled ? 'success' : 'neutral'} /></p>
          <div className="skills-actions">
            <Button label={curator?.paused ? 'Resume' : 'Pause'} data-testid="curator-pause" isDisabled={!curator || busy || learning}
              onClick={() => void changeCurator(!curator?.paused)}>{curator?.paused ? 'Resume' : 'Pause'}</Button>
            <Button label="Run now" data-testid="curator-run" variant="secondary" isDisabled={!curator || busy || learning}
              onClick={() => void runCurator()}>Run now</Button>
          </div>
          {curator?.last_run_at && <p>Last review <Timestamp value={curator.last_run_at} format="date_time" /></p>}
        </Card>
        <Card className="skills-management-card" data-testid="skills-graph">
          <h2>Learning graph</h2>
          <p data-testid="graph-count">{graph.nodes.length} nodes · {graph.edges.length} connections</p>
          {loading ? <Skeleton height={64} /> : !graph.nodes.length && !graph.edges.length ?
            <EmptyState title="No learning relationships yet" description="Connections appear as the agent learns." /> : <>
            {graph.nodes.length > 0 && <Table aria-label="Learning graph nodes" data={graph.nodes} idKey="id"
              columns={[{ key: 'label', header: 'Node' }, { key: 'kind', header: 'Kind' }]} density="compact" />}
            {graph.edges.length > 0 && <Table aria-label="Learning graph connections" data={graph.edges}
              columns={[{ key: 'source', header: 'Source' }, { key: 'target', header: 'Target' }]} density="compact" />}
          </>}
        </Card>
      </div>
      <Section variant="transparent" padding={0} className="skills-hub-section" data-testid="skills-hub">
        <h2>Skills Hub</h2><p>Official catalog</p>
        {loading ? <Skeleton height={72} /> : hub.length === 0 ? <EmptyState title="No catalog entries available" /> :
          <div className="skills-library-cards">{hub.map(item => {
            const identifier = item.identifier ?? item.name;
            const report = hubReports[identifier];
            const installed = hubImported.includes(identifier);
            return <Card key={identifier} data-testid={'hub-' + identifier}>
              <div className="skills-panel-title">
                <div><strong className="skills-name">{item.name}</strong><p>{item.category ?? 'general'}</p></div>
                <Button label="Scan" variant="secondary" size="sm" isDisabled={busy || loading || learning}
                  data-testid={'hub-scan-' + identifier} onClick={() => void scanHub(identifier)}>Scan</Button>
              </div>
              {report && <div className="hub-scan-details" data-testid={'hub-report-' + identifier}>
                <div className="skills-meta" role="status">
                  <Badge label={report.blocked ? report.approved ? 'Approved by admin' : 'Blocked by scan' : 'Scan passed'}
                    variant={report.blocked && !report.approved ? 'warning' : 'success'} />
                  <span>{report.files.length} files scanned</span>
                </div>
                {report.blocked && !report.approved && <Banner status="warning" title="Administrator approval required before importing" />}
                {report.findings.length > 0 && <Collapsible trigger={report.findings.length + ' scan findings'}>
                  <ul className="skills-findings">{report.findings.map((finding, index) =>
                    <li key={index}><strong>{finding.file}:{finding.line}</strong><Badge label={finding.category} variant="warning" /><p>{finding.description}</p></li>
                  )}</ul>
                </Collapsible>}
                <div className="skills-actions">
                  {report.blocked && !report.approved && <Button label="Review scan" variant="secondary" size="sm" isDisabled={busy || learning}
                    onClick={() => { setHubApprovalReason(''); setError(''); setReviewing(identifier); }}>Review scan</Button>}
                  <Button label={installed ? 'Imported' : 'Install in Registry'} size="sm"
                    isDisabled={busy || learning || installed || (report.blocked && !report.approved)}
                    data-testid={'hub-install-' + identifier} onClick={() => void installHub(identifier)}>
                    {installed ? 'Imported' : 'Install in Registry'}</Button>
                </div>
              </div>}
            </Card>;
          })}</div>}
      </Section>
    </div>
    <Dialog isOpen={learnOpen} purpose="form" width={560} onOpenChange={setLearnOpen}>
      <DialogHeader title="Learn a skill" />
      <form className="skills-dialog-form" onSubmit={event => void learn(event)}>
        <TextArea label="Describe a task or a workflow worth keeping" data-testid="learn-description" value={description}
          onChange={setDescription} placeholder="Turn our last workflow into a reusable skill" rows={5} isRequired />
        <div className="skills-dialog-actions">
          <Button label="Cancel" variant="secondary" onClick={() => setLearnOpen(false)}>Cancel</Button>
          <Button label="Learn" data-testid="learn-submit" type="submit" isDisabled={learning || !description.trim()} isLoading={learning}>Learn</Button>
        </div>
      </form>
    </Dialog>
    <Dialog isOpen={reviewing !== null} purpose="form" width={560} onOpenChange={open => { if (!open && !busy) setReviewing(null); }}>
      <DialogHeader title="Review blocked skill scan" />
      {reviewing && hubReports[reviewing] && <form className="skills-dialog-form" onSubmit={event => {
        event.preventDefault();
        if (!busy && hubApprovalReason.trim()) void approveHub(reviewing);
      }}>
        <Banner status="warning" title={'Approval allows importing ' + reviewing} />
        <p>Only administrators can approve the scan. Review the findings and record the reason for approval.</p>
        <ul className="skills-findings">{hubReports[reviewing].findings.map((finding, index) =>
          <li key={index}><strong>{finding.file}:{finding.line}</strong><Badge label={finding.category} variant="warning" /><p>{finding.description}</p></li>
        )}</ul>
        {error && <Banner status="error" title={error} role="alert" />}
        <TextInput label="Admin approval reason" value={hubApprovalReason} onChange={setHubApprovalReason} isRequired isDisabled={busy} />
        <div className="skills-dialog-actions">
          <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={() => setReviewing(null)}>Cancel</Button>
          <Button label="Approve scan" type="submit" data-testid={'hub-approve-' + reviewing} isLoading={busy}
            isDisabled={busy || !hubApprovalReason.trim()}>Approve scan</Button>
        </div>
      </form>}
    </Dialog>
  </section>;
}
