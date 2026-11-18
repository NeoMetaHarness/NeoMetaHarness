import type { Computer, ComputerInput, ComputerProvider, ComputerAttachContext } from '@neometaharness/computers';
import type { VaultService } from '@neometaharness/vault';
import { RfbClient } from './rfb.js';
import { encodePng } from './png.js';

function targetAddress(target: string) {
  const match = /^(?:\[([a-fA-F0-9:.]+)\]|([a-zA-Z0-9._-]+)):(\d{1,5})(?:#([A-Z][A-Z0-9_]{0,127}))?$/.exec(target);
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) throw new Error('VNC target must be host:port#VAULT_SECRET (or host:port for None)');
  return { host: match[1] ?? match[2], port: Number(match[3]), secret: match[4] };
}
const namedKeys: Record<string, number> = {
  enter: 0xff0d, return: 0xff0d, tab: 0xff09, backspace: 0xff08, escape: 0xff1b, esc: 0xff1b,
  delete: 0xffff, insert: 0xff63, home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, space: 0x20,
  ctrl: 0xffe3, control: 0xffe3, alt: 0xffe9, shift: 0xffe1, meta: 0xffeb, super: 0xffeb,
};
function characterKey(character: string): number {
  if (character === '\n' || character === '\r') return 0xff0d;
  if (character === '\t') return 0xff09;
  const code = character.codePointAt(0)!;
  return code <= 255 ? code : 0x01000000 + code;
}
function keyName(name: string): number {
  const known = namedKeys[name.toLowerCase()]; if (known) return known;
  if (/^F(?:[1-9]|1[0-2])$/i.test(name)) return 0xffbd + Number(name.slice(1));
  if ([...name].length === 1) return characterKey(name);
  throw new Error('Unsupported VNC key name');
}

export class VncComputerProvider implements ComputerProvider {
  readonly capabilities = { screen: true, input: true, browserCdp: false, shell: false, files: false, snapshot: false };
  private readonly sessions = new Map<string, { abort: AbortController; client?: RfbClient }>();
  private disposed = false;
  constructor(private readonly vault: Pick<VaultService, 'get'>) {}
  provision(): never { throw new Error('VNC attaches existing desktops; provisioning is unsupported'); }
  async attach(target: string, context?: ComputerAttachContext): Promise<Computer> {
    if (this.disposed) throw new Error('VNC provider disabled');
    if (this.sessions.has(target)) throw new Error('VNC target is already attached');
    const address = targetAddress(target), session = { abort: new AbortController(), client: undefined as RfbClient | undefined };
    this.sessions.set(target, session);
    try {
      let password: string | undefined;
      if (address.secret) {
        if (!context?.workspaceId) throw new Error('Authenticated workspace required for VNC credentials');
        password = await this.vault.get({ kind: 'workspace', workspaceId: context.workspaceId }, address.secret) ?? undefined;
        if (password === undefined) throw new Error('VNC vault secret unavailable in this workspace');
      }
      const client = await RfbClient.connect(address.host, address.port, password, 8000, session.abort.signal);
      session.client = client;
      let pointer = { x: 0, y: 0 };
      const move = async (x: number, y: number, mask = 0) => { pointer = { x: Math.round(x), y: Math.round(y) }; await client.pointer(pointer.x, pointer.y, mask); };
      const input = async (action: ComputerInput) => {
        if (action.action === 'move') await move(action.x, action.y);
        else if (action.action === 'click') { await move(action.x, action.y, 1); await move(action.x, action.y); }
        else if (action.action === 'type') {
          if (action.text.length > 10000) throw new Error('VNC text exceeds limit');
          for (const character of action.text) { const keysym = characterKey(character); await client.key(keysym, true); await client.key(keysym, false); }
        } else if (action.action === 'key') {
          const keys = (action.keys === '+' ? ['+'] : action.keys.split('+')).map(keyName);
          if (keys.length > 8) throw new Error('Too many VNC chord keys');
          const pressed: number[] = [];
          try { for (const keysym of keys) { await client.key(keysym, true); pressed.push(keysym); } }
          finally { for (const keysym of pressed.reverse()) await client.key(keysym, false); }
        } else {
          const mask = { up: 8, down: 16, left: 32, right: 64 }[action.direction.toLowerCase()];
          if (!mask || !Number.isFinite(action.amount) || action.amount < 0) throw new Error('Unsupported VNC scroll');
          for (let i = 0; i < Math.min(100, Math.ceil(action.amount)); i++) { await move(pointer.x, pointer.y, mask); await move(pointer.x, pointer.y); }
        }
      };
      return {
        screen: () => ({ protocol: 'png' }), lease: () => {}, input,
        capture: async () => ({ png: encodePng(client.width, client.height, await client.capture()).toString('base64'), width: client.width, height: client.height }),
      };
    } catch (error) { session.abort.abort(); if (this.sessions.get(target) === session) this.sessions.delete(target); throw error; }
  }
  release(id: string): void {
    const session = this.sessions.get(id); this.sessions.delete(id); session?.abort.abort(); session?.client?.close();
  }
  close(): void { this.disposed = true; for (const id of this.sessions.keys()) this.release(id); }
}
