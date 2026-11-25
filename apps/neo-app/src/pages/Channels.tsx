import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { AlertDialog, Badge, Banner, Button, Card, Heading, Selector, Spinner, Text, TextInput } from '@neometaharness/ui';
import { gatewayToken, gatewayUrl } from '../config';
import './channels.css';

type Client = ContractRouterClient<typeof neoContract>;
type Platform = Awaited<ReturnType<Client['x']['channels']['list']>>['platforms'][number];
const rpc = createORPCClient<Client>(new RPCLink({
  url: gatewayUrl(),
  headers: () => {
    const token = gatewayToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  },
}));

function isDisabled(reason: unknown): boolean {
  const error = reason as { status?: number; code?: string } | null;
  return error?.status === 404 || error?.code === 'NOT_FOUND' || /\b(404|disabled|not.found)\b/i.test(String(reason));
}

export default function Channels() {
  const [profiles, setProfiles] = useState<string[]>(['default']);
  const [profile, setProfile] = useState('default');
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [platform, setPlatform] = useState('telegram');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const live = useRef(true);
  const selected = useRef('default');

  useEffect(() => {
    live.current = true;
    void rpc.x['engine-hermes'].profiles.list().then((result) => {
      if (live.current) setProfiles([...new Set(['default', ...result.profiles.map((item) => item.name)])]);
    }).catch(() => { if (live.current) setError('Could not load bot profiles'); });
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    selected.current = profile;
    setPlatforms([]);
    setStatus('Loading');
    setError('');
    setToken('');
    setNotice('');
    void refresh(profile);
    const timer = window.setInterval(() => void refresh(profile, true), 3000);
    return () => window.clearInterval(timer);
  }, [profile]);

  async function refresh(name: string, quiet = false) {
    try {
      const result = await rpc.x.channels.status({ profile: name });
      if (!live.current || selected.current !== name) return;
      setPlatforms(result.platforms);
      setPlatform((previous) => result.platforms.some((item) => item.id === previous) ? previous : result.platforms[0]?.id ?? '');
      setStatus('Ready');
      if (!quiet) setError('');
    } catch (reason) {
      if (!live.current || selected.current !== name) return;
      if (isDisabled(reason)) {
        setStatus('disabled');
        setPlatforms([]);
      } else if (!quiet) {
        setStatus('Unavailable');
        setError('Could not load channels');
      }
    }
  }

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || platform !== 'telegram' || !token.trim()) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await rpc.x.channels.connect({ profile, platform: 'telegram', token });
      setToken('');
      setNotice('Telegram connected');
      await refresh(profile);
    } catch (reason) {
      if (isDisabled(reason)) setStatus('disabled');
      setError('Unable to connect Telegram');
    } finally { setBusy(false); }
  }

  async function disconnect() {
    if (busy || platform !== 'telegram') return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await rpc.x.channels.disconnect({ profile, platform: 'telegram' });
      setToken('');
      setNotice('Telegram disconnected');
      await refresh(profile);
    } catch (reason) {
      if (isDisabled(reason)) setStatus('disabled');
      setError('Unable to disconnect Telegram');
    } finally { setBusy(false); }
  }

  const selectedPlatform = platforms.find((item) => item.id === platform);
  return <section className="channels-page" data-testid="channels-page">
    <header className="page-header"><div><h1>Channels</h1><p>Connect messaging platforms to a bot.</p></div></header>
    <Card className="channels-panel" padding={4}>
      <Heading level={2}>Bot connection</Heading>
      <Selector label="Bot" id="channels-profile" data-testid="channels-profile" options={profiles} value={profile} isDisabled={busy}
        onChange={setProfile} />
      <Selector label="Platform" id="channels-platform" data-testid="channels-platform" value={platform}
        options={platforms.map(item => ({ value: item.id, label: item.name || item.id }))} isDisabled={busy || status !== 'Ready'}
        onChange={value => { setPlatform(value); setToken(''); }} />
      <div data-testid="channels-status" role="status" className="channels-state">
        {status === 'Loading' ? <Spinner label="Checking connection" /> : status === 'Ready'
          ? <><Text weight="bold">{selectedPlatform?.name ?? platform}</Text><Badge label={selectedPlatform?.enabled ? 'enabled' : 'disconnected'} variant={selectedPlatform?.enabled ? 'success' : 'neutral'} /></>
          : <Badge label={status === 'disabled' ? 'Channels extension disabled' : 'Unavailable'} variant="warning" />}
      </div>
      {selectedPlatform?.description && <Text as="p">{selectedPlatform.description}</Text>}
      {status === 'Ready' && selectedPlatform && platform === 'telegram' && (selectedPlatform.enabled
        ? <Button label="Disconnect" data-testid="channels-disconnect" variant="destructive" isDisabled={busy} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
        : <form onSubmit={event => void connect(event)}>
          <TextInput label="Telegram bot token" id="channels-token" data-testid="channels-token" type="password" autoComplete="off" value={token} onChange={setToken} isDisabled={busy} isRequired />
          <Button label="Connect" data-testid="channels-connect" type="submit" isDisabled={busy || !token.trim()}>Connect</Button>
        </form>)}
      {notice && <Banner status="success" title={notice} />}
      {error && <Banner role="alert" status="error" title={error} />}
    </Card>
    <AlertDialog isOpen={confirmDisconnect} onOpenChange={setConfirmDisconnect} title="Disconnect Telegram?"
      description={`Disconnect Telegram from ${profile}. This bot will stop receiving messages from this channel.`}
      actionLabel="Confirm disconnect" actionVariant="destructive" onAction={() => { setConfirmDisconnect(false); if (selectedPlatform?.enabled) void disconnect(); }} />
  </section>;
}
