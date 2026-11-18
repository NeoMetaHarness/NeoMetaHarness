import { useState } from 'react';
import { Button } from '@neometaharness/ui';

export default function VncAttach({ busy, attach }: { busy: boolean; attach(target: string): void }) {
  const [address, setAddress] = useState('');
  const [secret, setSecret] = useState('');
  return <form className="computers-vnc" aria-label="Attach VNC desktop" onSubmit={event => {
    event.preventDefault(); if (address.trim() && !busy) attach(`${address.trim()}${secret.trim() ? '#' + secret.trim() : ''}`);
  }}>
    <label>VNC address<input aria-label="VNC address" placeholder="host:5900" value={address} onChange={event => setAddress(event.target.value)} required /></label>
    <label>Vault secret name<input aria-label="VNC vault secret name" placeholder="VNC_PASSWORD" value={secret} onChange={event => setSecret(event.target.value)} /></label>
    <small>Uses this workspace's vault. Leave the secret name blank for an unauthenticated server.</small>
    <Button label="Attach VNC" data-testid="attach-vnc" type="submit" isDisabled={busy || !address.trim()}>Attach VNC</Button>
  </form>;
}
