import { assertSafeProviderUrl, defineExtension } from '@neometaharness/kernel';
import { xSearchInput, type NeoSearchService, type XSearchInput, type XSearchOutput } from '@neometaharness/contracts';

export interface SearchHttpClient {
  request(url: string, init: RequestInit): Promise<Response>;
}

export interface SearchSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  allowPrivateNetwork?: boolean;
}

const defaultHttpClient: SearchHttpClient = {
  request: (url, init) => fetch(url, init),
};

function searchEndpoint(origin: string): URL {
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error('Invalid X Search endpoint configuration'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid X Search endpoint configuration');
  }
  if (url.pathname !== '/' && url.pathname !== '/v1' && url.pathname !== '/v1/') {
    throw new Error('Invalid X Search endpoint configuration');
  }
  return new URL('/v1/responses', url.origin);
}

function validCitation(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
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

function parseSearchResponse(data: SearchResponse, apiKey: string): XSearchOutput {
  const contents = Array.isArray(data.output)
    ? data.output.filter((item) => item.type === 'message').flatMap((item) => item.content ?? [])
    : [];
  const text = (data.output_text || contents
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '').join('\n\n')).replaceAll(apiKey, '[redacted]');
  const citations = [
    ...(Array.isArray(data.citations) ? data.citations : []),
    ...contents.flatMap((item) => (item.annotations ?? [])
      .filter((annotation) => annotation.type === 'url_citation').map((annotation) => annotation.url)),
  ].map(validCitation).filter((url): url is string => !!url && !url.includes(apiKey));
  const usage = data.usage?.server_side_tool_usage_details;
  return {
    text,
    citations: [...new Set(citations)],
    usage: {
      postsFetched: Math.max(0, Math.trunc(usage?.x_posts_fetched ?? 0)),
      usersFetched: Math.max(0, Math.trunc(usage?.x_users_fetched ?? 0)),
    },
  };
}

export class XSearchService implements NeoSearchService {
  constructor(
    private readonly settings: SearchSettings,
    private readonly httpClient: SearchHttpClient = defaultHttpClient,
  ) {}

  get configured(): boolean {
    return Boolean(this.settings.apiKey?.trim());
  }

  async search(rawInput: XSearchInput): Promise<XSearchOutput> {
    const input = xSearchInput.parse(rawInput);
    if (input.fromDate && input.toDate && input.fromDate > input.toDate) {
      throw new Error('Invalid X Search date range');
    }
    const key = this.settings.apiKey?.trim();
    if (!key) throw new Error('X Search API key is not configured');
    const endpoint = searchEndpoint(this.settings.baseUrl ?? 'https://api.x.ai');
    await assertSafeProviderUrl(endpoint, { allowPrivateNetwork: this.settings.allowPrivateNetwork });
    const tool: Record<string, unknown> = { type: 'x_search' };
    if (input.allowedHandles) tool.allowed_x_handles = input.allowedHandles;
    if (input.excludedHandles) tool.excluded_x_handles = input.excludedHandles;
    if (input.fromDate) tool.from_date = input.fromDate;
    if (input.toDate) tool.to_date = input.toDate;
    let response: Response;
    try {
      response = await this.httpClient.request(endpoint.href, {
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
      return parseSearchResponse(await response.json() as SearchResponse, key);
    } catch {
      throw new Error('X Search returned an invalid response');
    }
  }
}

export default defineExtension({
  activate(ctx) {
    const settings = ctx.inject<SearchSettings>('settings') ?? {};
    const client = ctx.inject<SearchHttpClient>('searchHttpClient') ?? defaultHttpClient;
    const search = new XSearchService(settings, client);
    ctx.provide('neo.search', search);
    ctx.contribute('tools', {
      id: 'x-search.search',
      name: 'Search X posts',
      description: 'Search and cite current X posts through the configured xAI provider',
      route: '/x/x-search/search',
    });
    ctx.route('status', () => ({ providerId: 'xai', configured: search.configured }));
    ctx.route('search', ({ body }) => search.search(body as XSearchInput));
    ctx.health(() => ({ ok: true }));
  },
});
