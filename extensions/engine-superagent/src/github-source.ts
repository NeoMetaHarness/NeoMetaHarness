import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VaultService } from '@neometaharness/vault';

export type GitHubRepository = { name: string; ref: string };
/** What to poll and which bot does the work. Whether work starts is the workspace accept mode, held by the service. */
export type GitHubConfig = { repositories: GitHubRepository[]; botId?: string };
export type GitHubEvent =
  | { kind: 'comment'; key: string; repo: string; issue: number; url: string; text: string; botId?: string }
  | { kind: 'check'; key: string; repo: string; url: string; name: string; conclusion: string; botId?: string };

export type ConfirmedPullRequest = { number: number; url: string; branch: string; commit: string };
export interface GitHubSource {
  pullRequest?(input: { repo: string; branch: string; commit: string }): Promise<ConfirmedPullRequest | null>;
  configure(config: GitHubConfig, token?: string): Promise<void>;
  status(): Promise<{ repositories: GitHubRepository[]; botId?: string; hasToken: boolean; pausedUntil: number | null; stopped: boolean }>;
  poll(): Promise<{ checked: number; created: number; pausedUntil: number | null }>;
  reply(repo: string, issue: number, text: string): Promise<void>;
  stop(): void;
}

const scope = { kind: 'workspace' as const, workspaceId: 'default' };
const credential = 'NMH_SUPERAGENT_GITHUB_TOKEN';
const validRepo = /^[\w.-]+\/[\w.-]+$/;
const validRef = /^[\w./-]+$/;
const pollIntervalMs = 120_000;

type SavedState = { config: GitHubConfig; seen: string[] };
type Comment = {
  id: number; body?: string | null; html_url?: string;
  issue_url?: string; pull_request_url?: string;
};
type CheckRun = { id: number; name: string; status: string; conclusion?: string | null; html_url?: string };

/** GitHub REST API: /issues/comments, /pulls/comments, /commits/{ref}/check-runs,
 * and POST /issues/{issue_number}/comments.
 * https://docs.github.com/en/rest/issues/comments
 * https://docs.github.com/en/rest/pulls/comments
 * https://docs.github.com/en/rest/checks/runs
 */
export class PollingGitHubSource implements GitHubSource {
  private config: GitHubConfig = { repositories: [] };
  /** Per-source mode found in a P6-4 state file, used once to seed the workspace accept mode. */
  legacyMode?: 'observe' | 'act';
  private seen = new Set<string>();
  private pausedUntil: number | null = null;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<{ checked: number; created: number; pausedUntil: number | null }>;
  private activeObserved = false;
  private unobservedFailure?: { error: unknown };
  private readonly abort = new AbortController();

  constructor(private readonly file: string, private readonly vault: VaultService,
    private readonly onEvent: (event: GitHubEvent) => Promise<void>,
    private readonly transport: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.github.com',
    private readonly intervalMs = pollIntervalMs) {}

  async start(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as SavedState;
      // P6-4 files also carry a per-source `mode`; the workspace accept mode replaces it.
      const legacy = (saved.config as { mode?: unknown }).mode;
      if (legacy === 'observe' || legacy === 'act') this.legacyMode = legacy;
      this.config = { repositories: saved.config.repositories ?? [],
        ...(saved.config.botId ? { botId: saved.config.botId } : {}) };
      this.seen = new Set(saved.seen.slice(-4000));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (this.config.repositories.length) this.schedule(0);
  }

  async configure(config: GitHubConfig, token?: string): Promise<void> {
    if (this.stopped) throw new Error('GitHub source has stopped');
    const botId = config.botId ?? this.config.botId;
    for (const repo of config.repositories) {
      if (!validRepo.test(repo.name) || !validRef.test(repo.ref) || repo.ref.includes('..')) {
        throw new Error('Invalid GitHub repository or ref');
      }
    }
    if (token) await this.vault.put(scope, credential, token);
    this.config = { repositories: [...config.repositories], ...(botId ? { botId } : {}) };
    this.pausedUntil = null;
    this.unobservedFailure = undefined;
    await this.save();
    this.schedule(0);
  }

  async status() {
    return { ...this.config, hasToken: Boolean(await this.vault.get(scope, credential)),
      pausedUntil: this.pausedUntil, stopped: this.stopped };
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const pending = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(pending, JSON.stringify({ config: this.config, seen: [...this.seen].slice(-4000) }), 'utf8');
    await rename(pending, this.file);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || !this.config.repositories.length || this.pausedUntil === Number.MAX_SAFE_INTEGER) return;
    this.timer = setTimeout(() => {
      void this.pollOnce(false).catch(() => {}).finally(() => {
        if (!this.stopped) this.schedule(Math.max(this.intervalMs, (this.pausedUntil ?? 0) - Date.now()));
      });
    }, delay);
    this.timer.unref?.();
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.vault.get(scope, credential);
    if (!token) throw new Error('GitHub token must be configured in the workspace vault');
    const response = await this.transport(`${this.baseUrl}${path}`, {
      ...init, headers: { accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28',
        ...(init?.body ? { 'content-type': 'application/json' } : {}) },
      signal: this.abort.signal,
    });
    if (response.status === 403 || response.status === 429 || response.status === 401) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      this.pausedUntil = response.status === 429
        ? Math.max(Date.now() + 60_000, Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : 0),
          Number.isFinite(resetAt) ? resetAt : 0)
        : Number.MAX_SAFE_INTEGER;
      throw new Error(`GitHub polling paused after HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`GitHub REST HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  poll() {
    return this.pollOnce(true);
  }

  private pollOnce(observed: boolean) {
    if (this.active) {
      if (observed) this.activeObserved = true;
      return this.active;
    }
    if (this.pausedUntil !== null && Date.now() >= this.pausedUntil) this.unobservedFailure = undefined;
    // A scheduled poll may reach the rate limit just before an explicit request.
    // Surface that original error once instead of presenting its cooldown as success.
    if (observed && this.unobservedFailure) {
      const { error } = this.unobservedFailure;
      this.unobservedFailure = undefined;
      return Promise.reject(error);
    }
    if (this.stopped || (this.pausedUntil !== null && Date.now() < this.pausedUntil)) {
      return Promise.resolve({ checked: 0, created: 0, pausedUntil: this.pausedUntil });
    }
    this.unobservedFailure = undefined;
    this.activeObserved = observed;
    this.active = this.runPoll().catch(error => {
      if (!this.activeObserved && !this.stopped && this.pausedUntil !== null && Date.now() < this.pausedUntil) this.unobservedFailure = { error };
      throw error;
    }).finally(() => { this.active = undefined; });
    return this.active;
  }

  private async runPoll(): Promise<{ checked: number; created: number; pausedUntil: number | null }> {
    let checked = 0;
    let created = 0;
    try {
      for (const { name, ref } of this.config.repositories) {
        if (this.stopped) break;
        const path = `/repos/${name}`;
        const comments = [
          ...await this.request<Comment[]>(`${path}/issues/comments?per_page=100`),
          ...await this.request<Comment[]>(`${path}/pulls/comments?per_page=100`),
        ];
        const checks = await this.request<{ check_runs: CheckRun[] }>(
          `${path}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`);
        for (const comment of comments) {
          checked++;
          const request = /(?:^|\s)@neo\b\s*([\s\S]*)/i.exec(comment.body ?? '');
          const issue = /\/(?:issues|pulls)\/(\d+)(?:$|\?)/.exec(comment.issue_url ?? comment.pull_request_url ?? '');
          const key = `comment:${name}:${comment.id}`;
          if (!request?.[1]?.trim() || !issue || this.seen.has(key)) continue;
          await this.onEvent({ kind: 'comment', key, repo: name, issue: Number(issue[1]),
            url: comment.html_url ?? '', text: request[1].trim(), botId: this.config.botId });
          this.seen.add(key);
          created++;
        }
        for (const check of checks.check_runs) {
          checked++;
          const key = `check:${name}:${check.id}`;
          if (!['failure', 'timed_out', 'action_required'].includes(check.conclusion ?? '') || this.seen.has(key)) continue;
          await this.onEvent({ kind: 'check', key, repo: name,
            url: check.html_url ?? '', name: check.name, conclusion: check.conclusion!, botId: this.config.botId });
          this.seen.add(key);
          created++;
        }
      }
    } finally {
      if (created) await this.save();
    }
    return { checked, created, pausedUntil: this.pausedUntil };
  }

  /** GitHub REST GET /repos/{owner}/{repo}/pulls; read only, configured repositories only. */
  async pullRequest(input: { repo: string; branch: string; commit: string }): Promise<ConfirmedPullRequest | null> {
    if (this.stopped || (this.pausedUntil !== null && this.pausedUntil > Date.now())) throw new Error('GitHub source is stopped or paused');
    if (!validRepo.test(input.repo) || !this.config.repositories.some(repo => repo.name === input.repo)
      || !input.branch || input.branch.length > 160 || !/^[a-f0-9]{40}$/.test(input.commit)) throw new Error('Invalid or unconfigured PR destination');
    const owner = input.repo.split('/')[0];
    const pulls = await this.request<Array<{ number: number; state: string; html_url: string;
      head: { ref: string; sha: string; repo?: { full_name: string } } }>>(`/repos/${input.repo}/pulls?state=open&head=${encodeURIComponent(owner + ':' + input.branch)}`);
    const pull = pulls.find(pr => pr.state === 'open' && pr.head?.ref === input.branch && pr.head?.sha === input.commit
      && pr.head?.repo?.full_name === input.repo && Number.isSafeInteger(pr.number) && pr.number > 0
      && pr.html_url === `https://github.com/${input.repo}/pull/${pr.number}`);
    return pull ? { number: pull.number, url: pull.html_url, branch: input.branch, commit: input.commit } : null;
  }

  async reply(repo: string, issue: number, text: string): Promise<void> {
    if (this.stopped || !validRepo.test(repo) || !Number.isSafeInteger(issue) || issue < 1) {
      throw new Error('Invalid GitHub comment destination');
    }
    await this.request(`/repos/${repo}/issues/${issue}/comments`, {
      method: 'POST', body: JSON.stringify({ body: text }),
    });
  }

  stop(): void {
    this.unobservedFailure = undefined;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
  }
}
