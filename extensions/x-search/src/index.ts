import { defineExtension } from '@neometaharness/kernel';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createEgressFetch, validateEgressUrl } from '@neometaharness/egress';
import { xSearchInput, type NeoSearchService, type XSearchInput, type XSearchOutput } from '@neometaharness/contracts';

export interface SearchHttpClient {
  request(url: string, init: RequestInit): Promise<Response>;
  close?(): Promise<void>;
}

export interface SearchSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  allowPrivateNetwork?: boolean;
  requestsPerMinutePerUser?: number;
  requestsPerMinutePerWorkspace?: number;
  requestsPerDayPerUser?: number;
  requestsPerDayPerWorkspace?: number;
}

export interface SearchRequester {
  userId: string;
  workspaceId: string;
}

interface QuotaCounter {
  minute: number;
  minuteCount: number;
  dayCount: number;
}

interface QuotaSnapshot {
  day: number;
  users: [string, QuotaCounter][];
  workspaces: [string, QuotaCounter][];
  legacy?: QuotaSnapshot;
}

class SearchRateLimitError extends Error {
  readonly code = 'X_SEARCH_RATE_LIMIT';
}

function quota(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximum
    ? value : fallback;
}


function searchEndpoint(origin: string): URL {
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error('Invalid X Search endpoint configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid X Search endpoint configuration');
  }
  if (url.pathname !== '/' && url.pathname !== '/v1' && url.pathname !== '/v1/') {
    throw new Error('Invalid X Search endpoint configuration');
  }
  return new URL('/v1/responses', url.origin);
}

function validCitation(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {}
  return;
}

type ResponseContent = { type?: string; text?: string; annotations?: Array<{ type?: string; url?: string }> };
type ResponseItem = { type?: string; content?: ResponseContent[] };
type SearchResponse = {
  output_text?: string;
  output?: ResponseItem[];
  citations?: string[];
  usage?: { server_side_tool_usage_details?: { x_posts_fetched?: number; x_users_fetched?: number } };
};

const MAX_SEARCH_TEXT = 32_000;
const MAX_SEARCH_CITATIONS = 32;
const MAX_SEARCH_RESPONSE_BYTES = 1_000_000;

async function readSearchJson(response: Response): Promise<SearchResponse> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SEARCH_RESPONSE_BYTES) throw new Error('X Search response too large');
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) {
    throw new Error('X Search response must be JSON');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SEARCH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('X Search response too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as SearchResponse;
}

function parseSearchResponse(data: SearchResponse, apiKey: string): XSearchOutput {
  const contents = Array.isArray(data.output)
    ? data.output.filter((item) => item.type === 'message').flatMap((item) => item.content ?? [])
    : [];
  const text = (data.output_text || contents
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '').join('\n\n')).replaceAll(apiKey, '[redacted]').slice(0, MAX_SEARCH_TEXT);
  const citations = [
    ...(Array.isArray(data.citations) ? data.citations : []),
    ...contents.flatMap((item) => (item.annotations ?? [])
      .filter((annotation) => annotation.type === 'url_citation').map((annotation) => annotation.url)),
  ].map(validCitation).filter((url): url is string => !!url && !url.includes(apiKey));
  const usage = data.usage?.server_side_tool_usage_details;
  return {
    text,
    citations: [...new Set(citations)].slice(0, MAX_SEARCH_CITATIONS),
    usage: {
      postsFetched: Math.max(0, Math.trunc(usage?.x_posts_fetched ?? 0)),
      usersFetched: Math.max(0, Math.trunc(usage?.x_users_fetched ?? 0)),
    },
  };
}

export class XSearchService implements NeoSearchService {
  private readonly userCounters = new Map<string, QuotaCounter>();
  private readonly workspaceCounters = new Map<string, QuotaCounter>();
  private counterDay = -1;
  constructor(
    private readonly settings: SearchSettings,
    private readonly httpClient?: SearchHttpClient,
    private readonly now: () => number = Date.now,
    private readonly quotaFile?: string,
    private readonly settingsFor?: (workspaceId: string) => Promise<SearchSettings>,
  ) {}

  private legacyObserved?: QuotaSnapshot;

  private parseQuotaState(serialized: string): QuotaSnapshot {
    try {
      const state = JSON.parse(serialized) as QuotaSnapshot;
      const valid = (snapshot: QuotaSnapshot): boolean =>
        Number.isSafeInteger(snapshot?.day)
        && Array.isArray(snapshot.users) && Array.isArray(snapshot.workspaces)
        && [...snapshot.users, ...snapshot.workspaces].every(([id, counter]) =>
          typeof id === 'string' && counter && Number.isSafeInteger(counter.minute)
          && Number.isSafeInteger(counter.minuteCount) && counter.minuteCount >= 0
          && Number.isSafeInteger(counter.dayCount) && counter.dayCount >= 0);
      if (!valid(state) || (state.legacy && !valid(state.legacy))) {
        throw new Error('Invalid X Search quota state');
      }
      // Old JSON writers used plain user IDs. A single-workspace snapshot can
      // be attributed exactly; multi-workspace aggregate counts cannot.
      const normalizeSingleWorkspace = (snapshot: QuotaSnapshot) => {
        if (snapshot.workspaces.length !== 1) return;
        const workspaceId = snapshot.workspaces[0][0];
        snapshot.users = snapshot.users.map(([id, counter]) => {
          try {
            const scoped = JSON.parse(id);
            if (Array.isArray(scoped) && scoped.length === 2
              && scoped.every(part => typeof part === 'string')) return [id, counter];
          } catch {}
          return [JSON.stringify([workspaceId, id]), counter];
        });
      };
      normalizeSingleWorkspace(state);
      if (state.legacy) normalizeSingleWorkspace(state.legacy);
      return state;
    } catch (error) {
      throw new Error('X Search quota state is unreadable', { cause: error });
    }
  }

  private loadQuotaState(serialized?: string): void {
    this.counterDay = -1;
    this.legacyObserved = undefined;
    this.userCounters.clear();
    this.workspaceCounters.clear();
    if (!serialized) return;
    const state = this.parseQuotaState(serialized);
    this.counterDay = state.day;
    this.legacyObserved = state.legacy;
    for (const [id, counter] of state.users) this.userCounters.set(id, counter);
    for (const [id, counter] of state.workspaces) this.workspaceCounters.set(id, counter);
  }

  dispose(): void { void this.httpClient?.close?.().catch(() => undefined); }

  get configured(): boolean {
    return Boolean(this.settings.apiKey?.trim());
  }

  private counterFor(map: Map<string, QuotaCounter>, id: string, minute: number): QuotaCounter {
    let counter = map.get(id);
    if (!counter) {
      counter = { minute, minuteCount: 0, dayCount: 0 };
      map.set(id, counter);
    }
    if (counter.minute !== minute) {
      counter.minute = minute;
      counter.minuteCount = 0;
    }
    return counter;
  }

  private reconcileLegacy(snapshot: QuotaSnapshot): void {
    const day = Math.floor(this.now() / 86_400_000);
    const minute = Math.floor(this.now() / 60_000);
    if (this.counterDay !== day) {
      this.userCounters.clear();
      this.workspaceCounters.clear();
      this.counterDay = day;
    }
    if (snapshot.day === day) {
      const reconcile = (current: Map<string, QuotaCounter>, entries: [string, QuotaCounter][],
        seen: [string, QuotaCounter][]) => {
        const previous = new Map(seen);
        for (const [id, old] of entries) {
          const last = previous.get(id);
          const count = this.counterFor(current, id, minute);
          count.dayCount += Math.max(0, old.dayCount - (last?.dayCount ?? 0));
          if (old.minute === minute) {
            count.minuteCount += Math.max(0, old.minuteCount - (last?.minute === minute ? last.minuteCount : 0));
          }
        }
      };
      const observed = this.legacyObserved?.day === day ? this.legacyObserved : undefined;
      reconcile(this.userCounters, snapshot.users, observed?.users ?? []);
      reconcile(this.workspaceCounters, snapshot.workspaces, observed?.workspaces ?? []);
    }
    // Retain the last imported legacy counters so a late write from the older
    // JSON generation contributes only its new charges, once, on the next call.
    this.legacyObserved = snapshot;
  }

  private async charge(requester: SearchRequester, settings: SearchSettings): Promise<void> {
    if (!this.quotaFile) {
      this.chargeCurrent(requester, settings);
      return;
    }
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        this.chargeStored(requester, settings);
        return;
      } catch (error) {
        if (!this.isSqliteBusy(error)) throw error;
        if (Date.now() >= deadline) throw new Error('X Search quota store is busy', { cause: error });
        // node:sqlite is synchronous. Never wait on SQLite's busy_timeout in
        // the gateway event loop: give competing transactions time to finish.
        await delay(20);
      }
    }
  }

  private isSqliteBusy(error: unknown): boolean {
    const sqliteError = error as { errcode?: number; code?: string; message?: string };
    return sqliteError?.errcode === 5 || sqliteError?.code === 'SQLITE_BUSY'
      || /database is (locked|busy)/i.test(sqliteError?.message ?? '');
  }

  private chargeStored(requester: SearchRequester, settings: SearchSettings): void {
    const database = new DatabaseSync(this.quotaFile!);
    try {
      database.exec('PRAGMA busy_timeout = 0');
      database.exec('CREATE TABLE IF NOT EXISTS quota_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
      database.exec('BEGIN IMMEDIATE');
      let denied: SearchRateLimitError | undefined;
      try {
        const row = database.prepare('SELECT value FROM quota_state WHERE id = 1').get() as { value: string } | undefined;
        const legacyFile = this.quotaFile!.replace(/\.sqlite$/, '.json');
        const legacy = legacyFile !== this.quotaFile && existsSync(legacyFile)
          ? readFileSync(legacyFile, 'utf8') : undefined;
        this.loadQuotaState(row?.value ?? legacy);
        if (legacy) {
          const snapshot = this.parseQuotaState(legacy);
          if (!row) this.legacyObserved = snapshot;
          else this.reconcileLegacy(snapshot);
        }
        try {
          this.chargeCurrent(requester, settings);
        } catch (error) {
          if (!(error instanceof SearchRateLimitError)) throw error;
          // Store any late legacy charges even when the next request hits its cap.
          denied = error;
        }
        const state = JSON.stringify({
          day: this.counterDay,
          users: [...this.userCounters],
          workspaces: [...this.workspaceCounters],
          legacy: this.legacyObserved,
        });
        database.prepare('INSERT INTO quota_state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(state);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      if (denied) throw denied;
    } finally {
      database.close();
    }
  }

  private chargeCurrent(requester: SearchRequester, settings: SearchSettings): void {
    if (!requester?.userId?.trim() || !requester.workspaceId?.trim()) {
      throw new Error('X Search requires requester user and workspace identity');
    }
    const time = this.now();
    const day = Math.floor(time / 86_400_000);
    const minute = Math.floor(time / 60_000);
    if (day !== this.counterDay) {
      this.userCounters.clear();
      this.workspaceCounters.clear();
      this.counterDay = day;
    }
    const user = this.counterFor(this.userCounters, JSON.stringify([requester.workspaceId, requester.userId]), minute);
    const workspace = this.counterFor(this.workspaceCounters, requester.workspaceId, minute);
    const checks = [
      [user.minuteCount, quota(settings.requestsPerMinutePerUser, 5, 60), 'user minute'],
      [workspace.minuteCount, quota(settings.requestsPerMinutePerWorkspace, 20, 600), 'workspace minute'],
      [user.dayCount, quota(settings.requestsPerDayPerUser, 100, 10_000), 'user day'],
      [workspace.dayCount, quota(settings.requestsPerDayPerWorkspace, 500, 100_000), 'workspace day'],
    ] as const;
    for (const [used, limit, scope] of checks) {
      if (used >= limit) throw new SearchRateLimitError(`X Search rate limit exceeded (${scope})`);
    }
    user.minuteCount++;
    workspace.minuteCount++;
    user.dayCount++;
    workspace.dayCount++;
  }

  async search(rawInput: XSearchInput, requester: SearchRequester): Promise<XSearchOutput> {
    if (!requester?.userId?.trim() || !requester.workspaceId?.trim()) {
      throw new Error('X Search requires requester user and workspace identity');
    }
    const settings = this.settingsFor ? await this.settingsFor(requester.workspaceId) : this.settings;
    const input = xSearchInput.parse(rawInput);
    if (input.fromDate && input.toDate && input.fromDate > input.toDate) {
      throw new Error('Invalid X Search date range');
    }
    const key = settings.apiKey?.trim();
    if (!key) throw new Error('X Search API key is not configured');
    const endpoint = searchEndpoint(settings.baseUrl ?? 'https://api.x.ai');
    validateEgressUrl(endpoint, settings.allowPrivateNetwork === true);
    const tool: Record<string, unknown> = { type: 'x_search' };
    if (input.allowedHandles) tool.allowed_x_handles = input.allowedHandles;
    if (input.excludedHandles) tool.excluded_x_handles = input.excludedHandles;
    if (input.fromDate) tool.from_date = input.fromDate;
    if (input.toDate) tool.to_date = input.toDate;
    await this.charge(requester, settings);
    let response: Response;
    try {
      const injected = this.httpClient
        ? (async (url: string | URL | Request, init?: RequestInit) =>
          this.httpClient!.request(String(url), init ?? {})) as typeof fetch
        : undefined;
      const guardedFetch = createEgressFetch(() => settings.allowPrivateNetwork === true, injected);
      response = await guardedFetch(endpoint.href, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: settings.model || 'grok-4.7', input: [{ role: 'user', content: input.query }], tools: [tool], max_turns: 2, store: false }),
      });
    } catch {
      throw new Error('X Search request failed');
    }
    if (!response.ok) throw new Error(`X Search upstream returned HTTP ${response.status}`);
    try {
      return parseSearchResponse(await readSearchJson(response), key);
    } catch {
      throw new Error('X Search returned an invalid response');
    }
  }
}

export default defineExtension({
  activate(ctx) {
    const settings = ctx.inject<SearchSettings>('settings') ?? {};
    const settingsFor = ctx.inject<(workspaceId: string) => Promise<SearchSettings>>('settingsFor');
    const client = ctx.inject<SearchHttpClient>('searchHttpClient');
    const extensionDataRoot = ctx.inject<string>('extensionDataDir');
    const dataDir = ctx.inject<string>('dataDir')
      ?? (extensionDataRoot ? join(extensionDataRoot, 'x-search') : undefined);
    if (!dataDir) throw new Error('X Search needs isolated extension storage for metered quotas');
    mkdirSync(dataDir, { recursive: true });
    const search = new XSearchService(settings, client, Date.now, join(dataDir, 'quotas.sqlite'), settingsFor);
    ctx.provide('neo.search', search);
    ctx.effect(() => () => search.dispose());
    ctx.contribute('tools', {
      id: 'x-search.search',
      name: 'Search X posts',
      description: 'Search and cite current X posts through the configured xAI provider',
      route: '/x/x-search/search',
    });
    ctx.route('status', () => ({ providerId: 'xai', configured: Boolean(settings.apiKey?.trim()) }));
    ctx.route('search', ({ body }) => {
      if (body && typeof body === 'object' && 'input' in body) {
        const request = body as { input: XSearchInput; requester: SearchRequester };
        return search.search(request.input, request.requester);
      }
      throw new Error('X Search requires authenticated requester identity');
    });
    ctx.health(() => ({ ok: true }));
  },
});
