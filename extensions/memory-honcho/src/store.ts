import { createHash } from 'node:crypto';
import type { MemoryDraft, MemoryEntry, MemoryQuery, MemoryStore } from '@neometaharness/db';
import type { VaultService } from '@neometaharness/vault';

type Status = 'ok' | 'degraded' | 'off';
type HonchoMessage = {
  id: string; content: string; peer_id: string; session_id: string;
  created_at: string; metadata?: Record<string, unknown>;
};
type SessionContext = {
  messages?: HonchoMessage[];
  summary?: { content?: string } | null;
  peer_representation?: string | null;
  peer_card?: string[] | null;
};
type Page<T> = { items: T[] };

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const honchoWorkspace = (workspace: string) => 'nmh_' + hash(workspace);
const honchoSession = (subjectId: string) => 'nmh_' + hash(subjectId);
const wsPath = (workspace: string) => '/v3/workspaces/' + honchoWorkspace(workspace);
const sessionPath = (workspace: string, subjectId: string) =>
  wsPath(workspace) + '/sessions/' + honchoSession(subjectId);
const messageId = (workspace: string, session: string, id: string) =>
  'nmh:' + Buffer.from(JSON.stringify([workspace, session, id])).toString('base64url');

function parseMessageId(id: string): [string, string, string] {
  if (!id.startsWith('nmh:')) throw new Error('Invalid Honcho message id');
  const parts = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8'));
  if (!Array.isArray(parts) || parts.length !== 3 || parts.some((part) => typeof part !== 'string')) {
    throw new Error('Invalid Honcho message id');
  }
  return parts as [string, string, string];
}

function entry(workspace: string, message: HonchoMessage): MemoryEntry {
  const meta = message.metadata ?? {};
  const timestamp = Date.parse(message.created_at) || Date.now();
  return {
    id: messageId(workspace, message.session_id, message.id),
    workspace,
    subject: meta.subject === 'user' ? 'user' : 'bot',
    subject_id: typeof meta.subjectId === 'string' ? meta.subjectId : 'global',
    text: message.content,
    source: typeof meta.source === 'string' ? meta.source : 'honcho',
    provenance: typeof meta.provenance === 'string' ? meta.provenance : 'Honcho',
    trust: meta.trust === 'confirmed' || meta.trust === 'untrusted' ? meta.trust : 'observed',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export class HonchoStore implements MemoryStore {
  private lastFailure = false;
  constructor(private readonly vault: VaultService) {}

  private async config(workspace: string) {
    const scope = { kind: 'workspace' as const, workspaceId: workspace };
    const [url, key] = await Promise.all([
      this.vault.get(scope, 'HONCHO_URL'), this.vault.get(scope, 'HONCHO_API_KEY'),
    ]);
    if (!url || !key) return undefined;
    return { url: url.replace(/\/v3\/?$/, '').replace(/\/$/, ''), key };
  }

  private async request<T>(workspace: string, method: string, path: string, body?: unknown): Promise<T> {
    const credentials = await this.config(workspace);
    if (!credentials) throw new Error('Honcho vault credentials missing');
    const response = await fetch(credentials.url + path, {
      method,
      headers: { authorization: 'Bearer ' + credentials.key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) {
      this.lastFailure = true;
      throw new Error('Honcho HTTP ' + response.status);
    }
    this.lastFailure = false;
    return response.status === 204 ? (undefined as T) : await response.json() as T;
  }

  async status(workspace: string): Promise<Status> {
    if (!await this.config(workspace)) return 'off';
    try {
      await this.request<{ status: string }>(workspace, 'GET', '/health');
      return this.lastFailure ? 'degraded' : 'ok';
    } catch {
      this.lastFailure = true;
      return 'degraded';
    }
  }

  private async ensure(workspace: string, subjectId: string) {
    const root = wsPath(workspace);
    await this.request(workspace, 'POST', '/v3/workspaces', { id: honchoWorkspace(workspace) });
    await this.request(workspace, 'POST', root + '/peers', { id: 'nmh_user' });
    await this.request(workspace, 'POST', root + '/peers', { id: 'nmh_bot' });
    await this.request(workspace, 'POST', root + '/sessions', {
      id: honchoSession(subjectId), peers: { nmh_user: {}, nmh_bot: {} },
    });
  }

  async add(draft: MemoryDraft): Promise<MemoryEntry> {
    await this.ensure(draft.workspace, draft.subjectId);
    const peer = draft.subject === 'user' ? 'nmh_user' : 'nmh_bot';
    const path = sessionPath(draft.workspace, draft.subjectId) + '/messages';
    const messages = await this.request<HonchoMessage[]>(draft.workspace, 'POST', path, {
      messages: [{ content: draft.text, peer_id: peer,
        metadata: { subject: draft.subject, subjectId: draft.subjectId,
          source: draft.source, provenance: draft.provenance, trust: draft.trust } }],
    });
    if (!messages[0]) throw new Error('Honcho returned no saved message');
    return entry(draft.workspace, messages[0]);
  }

  async writeTurn(input: { workspace: string; subjectId: string; user: string; assistant: string; session: string }) {
    await this.ensure(input.workspace, input.subjectId);
    const path = sessionPath(input.workspace, input.subjectId) + '/messages';
    return this.request<HonchoMessage[]>(input.workspace, 'POST', path, {
      messages: [
        { content: input.user, peer_id: 'nmh_user',
          metadata: { subject: 'user', subjectId: input.subjectId, source: 'honcho.turn',
            provenance: input.session, trust: 'observed' } },
        { content: input.assistant, peer_id: 'nmh_bot',
          metadata: { subject: 'bot', subjectId: input.subjectId, source: 'honcho.turn',
            provenance: input.session, trust: 'observed' } },
      ],
    });
  }

  async context(workspace: string, subjectId: string): Promise<string[]> {
    const result = await this.request<SessionContext>(
      workspace, 'GET', sessionPath(workspace, subjectId) + '/context?tokens=700');
    const lines: string[] = [];
    if (result.summary?.content) lines.push(result.summary.content);
    if (result.peer_representation) lines.push(result.peer_representation);
    if (result.peer_card) lines.push(...result.peer_card);
    for (const message of (result.messages ?? []).slice(-10)) {
      if (message.metadata?.deleted) continue;
      lines.push((message.peer_id === 'nmh_user' ? 'User: ' : 'Assistant: ') + message.content);
    }
    return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  async chat(workspace: string, subjectId: string, query: string): Promise<string> {
    const answer = await this.request<{ content: string | null }>(workspace, 'POST', wsPath(workspace) + '/chat',
      { session_id: honchoSession(subjectId), query, stream: false });
    return answer.content ?? '';
  }

  async list(query: MemoryQuery): Promise<MemoryEntry[]> {
    const root = wsPath(query.workspace);
    const sessions = await this.request<Page<{ id: string }>>(query.workspace, 'POST', root + '/sessions/list?page=1&size=50', {});
    const records: MemoryEntry[] = [];
    for (const session of sessions.items ?? []) {
      if (!session.id.startsWith('nmh_')) continue;
      const result = await this.request<Page<HonchoMessage>>(query.workspace, 'POST',
        root + '/sessions/' + session.id + '/messages/list?page=1&size=50&reverse=true', {});
      for (const message of result.items ?? []) {
        if (message.metadata?.deleted) continue;
        const item = entry(query.workspace, message);
        if (query.subjectId && item.subject_id !== query.subjectId) continue;
        if (query.source && item.source !== query.source) continue;
        if (query.query && !item.text.toLowerCase().includes(query.query.toLowerCase())) continue;
        records.push(item);
      }
    }
    return records.sort((a, b) => b.created_at - a.created_at).slice(0, query.limit ?? 50);
  }

  async update(id: string, changes: Partial<Pick<MemoryDraft, 'text' | 'trust' | 'source' | 'provenance'>>): Promise<MemoryEntry | undefined> {
    const [workspace, session, rawId] = parseMessageId(id);
    const path = wsPath(workspace) + '/sessions/' + session + '/messages/' + rawId;
    const original = await this.request<HonchoMessage>(workspace, 'GET', path);
    const old = entry(workspace, original);
    if (changes.text !== undefined && changes.text !== old.text) {
      const replacement = await this.add({ workspace, subject: old.subject, subjectId: old.subject_id,
        text: changes.text, trust: changes.trust ?? old.trust, source: changes.source ?? old.source,
        provenance: changes.provenance ?? old.provenance });
      await this.request(workspace, 'PUT', path, { metadata: { ...original.metadata, deleted: true } });
      return replacement;
    }
    const edited = await this.request<HonchoMessage>(workspace, 'PUT', path,
      { metadata: { ...original.metadata, ...changes } });
    return entry(workspace, edited);
  }

  async delete(id: string): Promise<boolean> {
    const [workspace, session, rawId] = parseMessageId(id);
    const path = wsPath(workspace) + '/sessions/' + session + '/messages/' + rawId;
    const original = await this.request<HonchoMessage>(workspace, 'GET', path);
    await this.request(workspace, 'PUT', path, { metadata: { ...original.metadata, deleted: true } });
    return true;
  }

  async export(workspace: string): Promise<Record<'SOUL.md' | 'USER.md' | 'MEMORY.md', string>> {
    const records = await this.list({ workspace });
    return { 'SOUL.md': '', 'USER.md': '', 'MEMORY.md': records.map((item) =>
      '- ' + item.text + ' [' + item.source + ']').join('\n') };
  }
}
