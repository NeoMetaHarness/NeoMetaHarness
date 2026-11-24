import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { AlertDialog, Badge, Banner, Button, CodeBlock, EmptyState, Heading, Section, SelectableCard, Selector, TextInput } from '@neometaharness/ui';
import { gatewayUrl, gatewayToken } from '../config';

type Client = ContractRouterClient<typeof neoContract>;
type Skill = { name: string; version: number; sourceProfile: string; sourcePath: string; trust: string; updatedAt: number;
  autonomy?: 'suggest' | 'auto-low' | 'auto';
  evaluation?: { status: 'unevaluated' | 'passed' | 'failed' | 'overridden'; error?: string; overrideBy?: string } };
type Version = { version: number; hash: string; metadata: Skill };
type Assignment = { name: string; engine: 'hermes' | 'dsh' | 'superagent'; targetId: string };
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
  const [targetEngine, setTargetEngine] = useState<'hermes' | 'dsh' | 'superagent'>('hermes');
  const [targetId, setTargetId] = useState('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [ceiling, setCeiling] = useState<'suggest' | 'auto-low' | 'auto'>('suggest');
  const [confirm, setConfirm] = useState<'override' | 'rollback' | null>(null);
  const ceilingRevision = useRef(0);

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
  const current = skills.find((item) => item.name === selected);
  const evalStatus = current?.evaluation?.status ?? 'unevaluated';
  const evalAllowed = evalStatus === 'passed' || evalStatus === 'overridden';
  useEffect(() => {
    if (!targetId.trim()) return;
    let active = true;
    const revision = ++ceilingRevision.current;
    void api.ceiling.get({ engine: targetEngine, targetId }).then((result) => {
      if (active && revision === ceilingRevision.current) setCeiling(result.ceiling);
    }).catch((reason) => { if (active && revision === ceilingRevision.current) setError(String(reason)); });
    return () => { active = false; };
  }, [targetEngine, targetId]);

  return <section className="skills-panel skills-registry" data-testid="registry-panel">
    <div className="skills-panel-title"><Heading level={2}>Neo Skill Registry</Heading>
      <Button label="Refresh registry" size="sm" variant="secondary" isDisabled={busy}
        onClick={() => void action(async () => { await refresh(); })}>Refresh</Button></div>
    <p>Versioned local skills. Assign a reviewed skill to another bot or a DSH session.</p>
    {error && <Banner status="error" title={error} />}
    {notice && <Banner status="success" title={notice} />}
    <Button label="Sync skills from bot" data-testid="registry-sync" isDisabled={busy}
      onClick={() => void action(async () => {
        const imported = await api.sync({ profile });
        await refresh();
        if (imported.length) await loadVersions(imported[0]!.name);
        setNotice(`${imported.length} skills synced from ${profile}`);
      })}>Sync from {profile}</Button>
    <div className="skills-registry-grid">
      <ul data-testid="registry-list" aria-label="Registry skills">
        {skills.map((item) => <li key={item.name} data-testid={`registry-skill-${item.name.replace('/', '--')}`}>
          <SelectableCard label={item.name} isSelected={selected === item.name} isDisabled={busy} onChange={() => void action(async () => { await loadVersions(item.name); })} padding={2}>
            <strong>{item.name}</strong><Badge label={`v${item.version}`} /> <Badge label={item.trust} />
            <small>Source bot {item.sourceProfile} · {item.sourcePath}</small>
          </SelectableCard>
        </li>)}
        {!skills.length && <li><EmptyState title="Registry is empty" description="Sync a learned skill from a bot." /></li>}
      </ul>
      {selected && <div data-testid="registry-details">
        <Heading level={3}>{selected}</Heading>
        <Section padding={3}>
        <Heading level={4}>Review and evaluation</Heading>
        <p>{versions.length} versions</p>
        <p data-testid="registry-eval-status">Evaluation for v{current?.version} — <Badge variant={evalAllowed ? "success" : evalStatus === "failed" ? "error" : "neutral"} label={evalStatus} /></p>
        <p data-testid="registry-autonomy">Autonomy — {current?.autonomy ?? 'suggest'}</p>
        {current?.evaluation?.error && <p role="status">{current.evaluation.error}</p>}
        <div className="skills-actions">
          <Button label="Run skill evaluation" data-testid="registry-evaluate" isDisabled={busy}
            onClick={() => void action(async () => {
              const result = await api.evaluate({ name: selected });
              await refresh(); await loadVersions(selected);
              setNotice(`Evaluation ${result.status} for v${result.version}`);
            })}>Run eval</Button>
          {!evalAllowed && <><TextInput label="Admin override reason" data-testid="registry-override-reason" value={overrideReason} onChange={setOverrideReason} />
          <Button label="Override evaluation" data-testid="registry-override" variant="secondary"
            isDisabled={busy || !overrideReason.trim()} onClick={() => setConfirm('override')}>Override</Button></>}
        </div>
        </Section>
        <Section padding={3}>
        <Heading level={4}>Versions</Heading>
        <Selector label="From version" data-testid="registry-from" options={versions.map(item => ({ value: String(item.version), label: `v${item.version}` }))} value={String(from)} onChange={value => setFrom(Number(value))} isDisabled={busy} />
        <Selector label="To version" data-testid="registry-to" options={versions.map(item => ({ value: String(item.version), label: `v${item.version}` }))} value={String(to)} onChange={value => setTo(Number(value))} isDisabled={busy} />
        <div className="skills-actions">
          <Button label="Compare versions" data-testid="registry-diff-button" isDisabled={busy}
            onClick={() => void action(async () => { setDiff((await api.diff({ name: selected, from, to })).diff); })}>Diff</Button>
          <Button label="Restore selected version" data-testid="registry-rollback" variant="secondary" isDisabled={busy}
            onClick={() => setConfirm('rollback')}>Rollback from v{from}</Button>
        </div>
        {diff && <div data-testid="registry-diff"><CodeBlock code={diff} hasCopyButton isDiff maxHeight={320} /></div>}
        </Section>
        <Section padding={3}>
        <Heading level={4}>Assign skill</Heading>
        <Selector label="Engine" data-testid="registry-engine" value={targetEngine} isDisabled={busy}
          options={[{ value: 'hermes', label: 'Hermes bot' }, { value: 'dsh', label: 'DSH session' }, { value: 'superagent', label: 'Superagent' }]}
          onChange={value => {
            ++ceilingRevision.current;
            const engine = value as typeof targetEngine;
            setTargetEngine(engine);
            setTargetId(engine === 'hermes' ? profile : engine === 'superagent' ? 'default' : '');
          }} />
        <TextInput label="Bot or session ID" data-testid="registry-target" {...{ list: 'registry-profiles' }} value={targetId} isDisabled={busy}
          onChange={value => { ++ceilingRevision.current; setTargetId(value); }} />
        <datalist id="registry-profiles">{profiles.map((name) => <option key={name} value={name} />)}</datalist>
        <Selector label="Target autonomy ceiling" data-testid="registry-ceiling" value={ceiling} isDisabled={busy}
          options={[{ value: 'suggest', label: 'Suggest' }, { value: 'auto-low', label: 'Auto low' }, { value: 'auto', label: 'Auto' }]}
          onChange={value => { ++ceilingRevision.current; setCeiling(value as typeof ceiling); }} />
        <Button label="Save autonomy ceiling" data-testid="registry-ceiling-save" isDisabled={busy || !targetId.trim()}
          onClick={() => void action(async () => {
            await api.ceiling.set({ engine: targetEngine, targetId, ceiling });
            setNotice(`Autonomy ceiling set to ${ceiling}`);
          })}>Save ceiling</Button>
        <Button label={assignment ? 'Unassign skill' : 'Assign skill'} data-testid="registry-assign"
          isDisabled={busy || !targetId.trim() || (!assignment && !evalAllowed)} onClick={() => void action(async () => {
            await api.assign({ name: selected, engine: targetEngine, targetId, assigned: !assignment });
            await refresh(); setNotice(assignment ? 'Skill unassigned' : 'Skill assigned');
          })}>{assignment ? 'Unassign' : 'Assign'}</Button>
        </Section>
      </div>}
      {!selected && <EmptyState title="Select a skill" description="Choose a registry skill to review its versions and assignments." />}
    </div>
    <AlertDialog isOpen={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }}
      title={confirm === 'override' ? 'Override evaluation?' : 'Restore version?'}
      description={confirm === 'override' ? `Override evaluation for ${selected} v${current?.version}. Reason: ${overrideReason}` : `Restore ${selected} v${from} as a new version of this skill.`}
      actionLabel={confirm === 'override' ? 'Confirm override' : 'Confirm restore'} actionVariant="destructive"
      onAction={() => {
        const choice = confirm;
        setConfirm(null);
        if (busy || !choice) return;
        void action(async () => {
          if (choice === 'override') {
            if (!overrideReason.trim() || evalAllowed) return;
            await api.override({ name: selected, reason: overrideReason });
            setOverrideReason(''); await refresh(); await loadVersions(selected);
            setNotice('Admin override recorded');
          } else {
            const result = await api.rollback({ name: selected, version: from });
            await refresh(); await loadVersions(selected);
            setNotice(`Restored v${from} as v${result.version}`);
          }
        });
      }} />
  </section>;
}
