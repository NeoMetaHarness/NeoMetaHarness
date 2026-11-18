import { useEffect, useRef, useState } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { Button } from '@neometaharness/ui';
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
    <div className="channels-panel">
      <label htmlFor="channels-profile">Bot</label>
      <select id="channels-profile" data-testid="channels-profile" value={profile} disabled={busy}
        onChange={(event) => setProfile(event.target.value)}>{profiles.map((name) =>
          <option key={name} value={name}>{name}</option>)}</select>
      <label htmlFor="channels-platform">Platform</label>
      <select id="channels-platform" data-testid="channels-platform" value={platform} disabled={busy || status === 'disabled'}
        onChange={(event) => { setPlatform(event.target.value); setToken(''); }}>
        {platforms.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
      </select>
      <p data-testid="channels-status" role="status">{status === 'disabled' ? 'Channels extension disabled'
        : `${selectedPlatform?.name ?? platform ?? 'Platform'}: ${selectedPlatform?.enabled ? 'enabled' : 'disconnected'}`}</p>
      {selectedPlatform?.description && <p>{selectedPlatform.description}</p>}
      <form onSubmit={(event) => void connect(event)}>
        <label htmlFor="channels-token">Telegram bot token</label>
        <input id="channels-token" data-testid="channels-token" type="password" autoComplete="off"
          value={token} onChange={(event) => setToken(event.target.value)} disabled={busy || platform !== 'telegram' || status === 'disabled'} />
        <div className="channels-actions">
          <Button label="Connect" data-testid="channels-connect" type="submit"
            isDisabled={busy || !token.trim() || platform !== 'telegram' || status === 'disabled'}>Connect</Button>
          <Button label="Disconnect" data-testid="channels-disconnect" type="button" variant="secondary"
            isDisabled={busy || platform !== 'telegram' || status === 'disabled'} onClick={() => void disconnect()}>Disconnect</Button>
        </div>
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && <p className="page-error" role="alert">{error}</p>}
    </div>
  </section>;
}
