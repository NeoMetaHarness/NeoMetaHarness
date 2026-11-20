import { defineExtension } from '@neometaharness/kernel';
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
  userId?: string;
  workspaceId?: string;
}

interface QuotaCounter {
  minute: number;
  minuteCount: number;
  dayCount: number;
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
  private readonly guardedFetch: typeof fetch;
  private readonly userCounters = new Map<string, QuotaCounter>();
  private readonly workspaceCounters = new Map<string, QuotaCounter>();
  private counterDay = -1;
  constructor(
    private readonly settings: SearchSettings,
    private readonly httpClient?: SearchHttpClient,
    private readonly now: () => number = Date.now,
  ) {
    const injected = httpClient
      ? (async (url: string | URL | Request, init?: RequestInit) =>
        httpClient.request(String(url), init ?? {})) as typeof fetch
      : undefined;
    this.guardedFetch = createEgressFetch(() => settings.allowPrivateNetwork === true, injected);
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

  private charge(requester: SearchRequester): void {
    const time = this.now();
    const day = Math.floor(time / 86_400_000);
    const minute = Math.floor(time / 60_000);
    if (day !== this.counterDay) {
      this.userCounters.clear();
      this.workspaceCounters.clear();
      this.counterDay = day;
    }
    const user = this.counterFor(this.userCounters, requester.userId || 'anonymous', minute);
    const workspace = this.counterFor(this.workspaceCounters, requester.workspaceId || 'default', minute);
    const checks = [
      [user.minuteCount, quota(this.settings.requestsPerMinutePerUser, 5, 60), 'user minute'],
      [workspace.minuteCount, quota(this.settings.requestsPerMinutePerWorkspace, 20, 600), 'workspace minute'],
      [user.dayCount, quota(this.settings.requestsPerDayPerUser, 100, 10_000), 'user day'],
      [workspace.dayCount, quota(this.settings.requestsPerDayPerWorkspace, 500, 100_000), 'workspace day'],
    ] as const;
    for (const [used, limit, scope] of checks) {
      if (used >= limit) throw new SearchRateLimitError(`X Search rate limit exceeded (${scope})`);
    }
    user.minuteCount++;
    workspace.minuteCount++;
    user.dayCount++;
    workspace.dayCount++;
  }

  async search(rawInput: XSearchInput, requester: SearchRequester = {}): Promise<XSearchOutput> {
    const input = xSearchInput.parse(rawInput);
    if (input.fromDate && input.toDate && input.fromDate > input.toDate) {
      throw new Error('Invalid X Search date range');
    }
    const key = this.settings.apiKey?.trim();
    if (!key) throw new Error('X Search API key is not configured');
    const endpoint = searchEndpoint(this.settings.baseUrl ?? 'https://api.x.ai');
    validateEgressUrl(endpoint, this.settings.allowPrivateNetwork === true);
    const tool: Record<string, unknown> = { type: 'x_search' };
    if (input.allowedHandles) tool.allowed_x_handles = input.allowedHandles;
    if (input.excludedHandles) tool.excluded_x_handles = input.excludedHandles;
    if (input.fromDate) tool.from_date = input.fromDate;
    if (input.toDate) tool.to_date = input.toDate;
    this.charge(requester);
    let response: Response;
    try {
      response = await this.guardedFetch(endpoint.href, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.settings.model || 'grok-4.7', input: [{ role: 'user', content: input.query }], tools: [tool], max_turns: 2, store: false }),
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
    const client = ctx.inject<SearchHttpClient>('searchHttpClient');
    const search = new XSearchService(settings, client);
    ctx.provide('neo.search', search);
    ctx.effect(() => () => search.dispose());
    ctx.contribute('tools', {
      id: 'x-search.search',
      name: 'Search X posts',
      description: 'Search and cite current X posts through the configured xAI provider',
      route: '/x/x-search/search',
    });
    ctx.route('status', () => ({ providerId: 'xai', configured: search.configured }));
    ctx.route('search', ({ body }) => {
      if (body && typeof body === 'object' && 'input' in body) {
        const request = body as { input: XSearchInput; requester: SearchRequester };
        return search.search(request.input, request.requester);
      }
      return search.search(body as XSearchInput);
    });
    ctx.health(() => ({ ok: true }));
  },
});
