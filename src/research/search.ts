// Search provider abstraction. Open-source first: SearXNG (self-hosted) is the
// default recommendation; Brave Search API is supported; with no provider
// configured, search reports that plainly instead of inventing results.
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export interface SearchProvider {
  readonly name: string;
  readonly configured: boolean;
  search(query: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

export class SearxngProvider implements SearchProvider {
  readonly name = 'searxng';
  readonly configured = true;
  #base: string;
  #fetch: typeof fetch;
  constructor(baseUrl: string, fetchImpl?: typeof fetch) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchImpl ?? fetch;
  }
  async search(query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const url = `${this.#base}/search?format=json&safesearch=1&q=${encodeURIComponent(query)}`;
    const res = await this.#fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal ?? AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`SearXNG returned HTTP ${res.status}`);
    const json: any = await res.json();
    return (json.results ?? []).slice(0, opts.limit ?? 8).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.content ?? ''), engine: `searxng:${r.engine ?? ''}` }));
  }
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave';
  readonly configured = true;
  #key: string;
  #fetch: typeof fetch;
  constructor(apiKey: string, fetchImpl?: typeof fetch) {
    this.#key = apiKey;
    this.#fetch = fetchImpl ?? fetch;
  }
  async search(query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchResult[]> {
    const res = await this.#fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${opts.limit ?? 8}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.#key },
      signal: opts.signal ?? AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`);
    const json: any = await res.json();
    return (json.web?.results ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.description ?? ''), engine: 'brave' }));
  }
}

export class NoSearchProvider implements SearchProvider {
  readonly name = 'none';
  readonly configured = false;
  async search(): Promise<SearchResult[]> {
    return [];
  }
}

export function createSearchProvider(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): SearchProvider {
  const kind = (env.RESEARCH_SEARCH_PROVIDER ?? (env.SEARXNG_URL ? 'searxng' : env.BRAVE_API_KEY ? 'brave' : 'none')).toLowerCase();
  if (kind === 'searxng' && env.SEARXNG_URL) return new SearxngProvider(env.SEARXNG_URL, fetchImpl);
  if (kind === 'brave' && env.BRAVE_API_KEY) return new BraveSearchProvider(env.BRAVE_API_KEY, fetchImpl);
  return new NoSearchProvider();
}

/** Classifies a source for provenance (the Main Agent weighs official sources above directories). */
export function classifySource(url: string, businessDomain: string | null): string {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'other';
  }
  if (businessDomain && (host === businessDomain || host.endsWith(`.${businessDomain}`))) return 'official_site';
  if (/(yelp|bbb|angi|homeadvisor|thumbtack|yellowpages|nextdoor|houzz|porch)\./.test(host)) return 'directory_or_reviews';
  if (/(google|bing|apple)\.(com|[a-z.]+)$/.test(host) && /maps|business/.test(url)) return 'map_listing';
  if (/(facebook|instagram|linkedin|x|twitter|youtube|tiktok)\.com$/.test(host)) return 'social_profile';
  if (/(news|times|post|herald|tribune|journal|gazette)/.test(host)) return 'news';
  if (/\.(gov|edu)$/.test(host) || /energy\.gov|epa\.gov/.test(host)) return 'authority';
  return 'web_page';
}
