import { useEffect, useRef, useState } from 'react';
import { Button, Card, Heading, TextInput, TextArea, Selector, Timestamp } from '@neometaharness/ui';
import { engineDisabled, hermesRpc, readableDate } from './hermes-work';
import './hermes-work.css';

type Job = Record<string, unknown>;
type History = { runs: Record<string, unknown>[]; limit: number };
const jobId = (job: Job): string => String(job.id ?? '');
const label = (job: Job): string => String(job.name || job.prompt || job.id || 'Routine');
const scheduleText = (job: Job): string => typeof job.schedule === 'object' && job.schedule
  ? String((job.schedule as Record<string, unknown>).display ?? '') : String(job.schedule ?? '');
const isPaused = (job: Job): boolean => job.state === 'paused';
const editableSchedule = (job: Job): string => {
  if (!job.schedule || typeof job.schedule !== 'object') return scheduleText(job);
  const details = job.schedule as Record<string, unknown>;
  if (details.kind === 'once') return String(details.run_at ?? '');
  if (details.kind === 'cron') return String(details.expr ?? '');
  return scheduleText(job);
};

function WorkDate({ value }: { value: unknown }) {
  const date = readableDate(value);
  return 'value' in date ? <Timestamp value={date.value} /> : <span>{date.label}</span>;
}

export default function Routines() {
  const [profiles, setProfiles] = useState<string[]>(['default']);
  const [profile, setProfile] = useState('default');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState('');
  const [history, setHistory] = useState<History | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState('every 1m');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading');
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const currentProfile = useRef(profile);
  const currentSelected = useRef(selected);

  useEffect(() => {
    mounted.current = true;
    void hermesRpc.x['engine-hermes'].profiles.list().then((result) => {
      if (mounted.current) setProfiles([...new Set(['default', ...result.profiles.map((entry) => entry.name)])]);
    }).catch((reason) => { if (mounted.current && engineDisabled(reason)) setStatus('disabled'); });
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    currentProfile.current = profile;
    setJobs([]);
    setSelected('');
    setHistory(null);
    setEditing(false);
    void refresh(profile);
    const timer = window.setInterval(() => void refresh(profile, true), 2000);
    return () => window.clearInterval(timer);
  }, [profile]);

  useEffect(() => {
    currentSelected.current = selected;
    setHistory(null);
    if (!selected) return;
    void loadHistory(profile, selected);
    const timer = window.setInterval(() => void loadHistory(profile, selected), 2000);
    return () => window.clearInterval(timer);
  }, [selected, profile]);

  async function refresh(owner: string, quiet = false) {
    try {
      const result = await hermesRpc.x['engine-hermes'].cron.list({ profile: owner });
      if (!mounted.current || currentProfile.current !== owner) return;
      setJobs(result);
      setStatus('Ready');
      if (!quiet) setError('');
    } catch (reason) {
      if (!mounted.current || currentProfile.current !== owner) return;
      if (engineDisabled(reason)) setStatus('disabled');
      else if (!quiet) setError('Could not load routines');
    }
  }

  async function loadHistory(owner: string, id: string) {
    try {
      const result = await hermesRpc.x['engine-hermes'].cron.history({ profile: owner, id });
      if (mounted.current && currentProfile.current === owner && currentSelected.current === id) setHistory(result);
    } catch (reason) { if (mounted.current && engineDisabled(reason)) setStatus('disabled'); }
  }

  function edit(job: Job) {
    setSelected(jobId(job));
    setEditing(true);
    setName(String(job.name ?? ''));
    setPrompt(String(job.prompt ?? ''));
    setSchedule(editableSchedule(job));
  }

  function clearForm() { setEditing(false); setName(''); setPrompt(''); setSchedule('every 1m'); }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !prompt.trim() || !schedule.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (editing && selected) {
        await hermesRpc.x['engine-hermes'].cron.update({ id: selected, profile, name, prompt, schedule });
      } else {
        const result = await hermesRpc.x['engine-hermes'].cron.create({ profile, name, prompt, schedule });
        setSelected(result.id);
      }
      clearForm();
      await refresh(profile);
    } catch (reason) {
      setError(engineDisabled(reason) ? 'Hermes engine disabled' : `Could not save routine: ${String(reason)}`);
      if (engineDisabled(reason)) setStatus('disabled');
    } finally { setBusy(false); }
  }

  async function act(action: 'pause' | 'trigger' | 'delete', job: Job) {
    if (busy) return;
    setBusy(true);
    setError('');
    const id = jobId(job);
    try {
      if (action === 'pause') await hermesRpc.x['engine-hermes'].cron.pause({ id, profile, paused: !isPaused(job) });
      if (action === 'trigger') await hermesRpc.x['engine-hermes'].cron.trigger({ id, profile });
      if (action === 'delete') {
        await hermesRpc.x['engine-hermes'].cron.delete({ id, profile });
        if (selected === id) { setSelected(''); clearForm(); }
      }
      await refresh(profile);
      if (selected === id) await loadHistory(profile, id);
    } catch (reason) {
      setError(engineDisabled(reason) ? 'Hermes engine disabled' : `Could not ${action} routine: ${String(reason)}`);
      if (engineDisabled(reason)) setStatus('disabled');
    } finally { setBusy(false); }
  }

  return <section className="hermes-work" data-testid="routines-page">
    <header className="page-header"><div><h1>Routines</h1><p>Schedule recurring work for your bots.</p></div></header>
    <p role="status" data-testid="routines-status">{status === 'disabled' ? 'Hermes engine disabled' : status}</p>
    {error && <p role="alert" className="page-error">{error}</p>}
    {status !== 'disabled' && <>
      <div className="work-toolbar"><Selector label="Bot" id="routine-profile" htmlName="routine-profile" value={profile} onChange={setProfile} isDisabled={busy} options={profiles.map(entry => ({ value: entry, label: entry }))} /></div>
      <div className="work-grid"><div>
        <Heading level={2}>Scheduled routines</Heading>
        {jobs.length === 0 && <p>No routines yet.</p>}
        {jobs.map((job) => <Card className="work-card" key={jobId(job)} data-testid="routine-card">
          <Button label={label(job)} variant="ghost" onClick={() => setSelected(jobId(job))}>{label(job)}</Button>
          <p>{scheduleText(job)} · {isPaused(job) ? 'Paused' : String(job.state ?? 'Active')}</p>
          <p>Last run <WorkDate value={job.last_run_at} /><br />Next run <WorkDate value={job.next_run_at} /></p>
          <div className="work-actions">
            <Button label="Edit" onClick={() => edit(job)} isDisabled={busy}>Edit</Button>
            <Button label={isPaused(job) ? 'Resume' : 'Pause'} onClick={() => void act('pause', job)} isDisabled={busy || job.state === 'completed'}>{isPaused(job) ? 'Resume' : 'Pause'}</Button>
            <Button label="Run now" onClick={() => void act('trigger', job)} isDisabled={busy}>Run now</Button>
            <Button label="Delete" variant="secondary" onClick={() => void act('delete', job)} isDisabled={busy}>Delete</Button>
          </div>
        </Card>)}
      </div><div>
        <form className="work-form" onSubmit={(event) => void save(event)}>
          <Heading level={2}>{editing ? 'Edit routine' : 'New routine'}</Heading>
          <TextInput label="Name" id="routine-name" ref={el => { if (el) el.dataset.testid = "routine-name"; }} value={name} onChange={setName} />
          <TextInput label="Schedule" id="routine-schedule" ref={el => { if (el) el.dataset.testid = "routine-schedule"; }} value={schedule} onChange={setSchedule} isRequired />
          <TextArea label="Prompt" id="routine-prompt" ref={el => { if (el) el.dataset.testid = "routine-prompt"; }} value={prompt} onChange={setPrompt} rows={5} isRequired />
          <div className="work-actions"><Button label={editing ? 'Save changes' : 'Create routine'} type="submit" isDisabled={busy || !prompt.trim() || !schedule.trim()}>{editing ? 'Save changes' : 'Create routine'}</Button>
            {editing && <Button label="Cancel editing" type="button" variant="secondary" onClick={clearForm}>Cancel</Button>}
          </div>
        </form>
        <section className="work-history" data-testid="routine-history"><Heading level={2}>Run history</Heading>
          {!selected ? <p>Select a routine to view its runs.</p> : !history?.runs.length ? <p>No runs yet.</p>
            : <ul>{history.runs.map((run, index) => <li key={String(run.id ?? index)}>
              <strong>{String(run.title ?? run.status ?? 'Run')}</strong><span><WorkDate value={run.started_at} /></span>
            </li>)}</ul>}
        </section>
      </div></div>
    </>}
  </section>;
}
