import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { VaultService } from '@neometaharness/vault';
import { PollingGitHubSource, type GitHubEvent } from '../src/github-source.js';

const temp = await mkdtemp(join(tmpdir(), 'nmh-github-source-'));
let status = 200;
let beforeResponse: () => Promise<void> = async () => {};
const requests: { method: string; url: string; token: string; body: string }[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  requests.push({ method: req.method ?? '', url: req.url ?? '', token: req.headers.authorization ?? '',
    body: Buffer.concat(chunks).toString('utf8') });
  await beforeResponse();
  if (status !== 200) {
    res.writeHead(status, { 'retry-after': '120' }).end(JSON.stringify({ message: 'rate limited' }));
    return;
  }
  const issue = { id: 12, body: '@neo summarise this issue',
    issue_url: 'https://api.github.com/repos/acme/sample/issues/7',
    html_url: 'https://github.com/acme/sample/issues/7#issuecomment-12' };
  const review = { id: 13, body: 'Please @neo review the proposed change',
    pull_request_url: 'https://api.github.com/repos/acme/sample/pulls/8',
    html_url: 'https://github.com/acme/sample/pull/8#discussion_r13' };
  const data = req.method === 'POST' ? { id: 99 }
    : req.url?.includes('/pulls?') ? [{ number: 9, state: 'open', html_url: 'https://github.com/acme/sample/pull/9', head: { ref: 'neo/feature', sha: 'a'.repeat(40), repo: { full_name: 'acme/sample' } } }]
    : req.url?.includes('/issues/comments?') ? [issue]
    : req.url?.includes('/pulls/comments?') ? [review]
    : { check_runs: [{ id: 33, name: 'build', status: 'completed', conclusion: 'failure',
      html_url: 'https://github.com/acme/sample/actions/runs/33' }] };
  res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
});

const vaultData = new Map<string, string>();
const vault = {
  async put(_scope: unknown, name: string, value: string) { vaultData.set(name, value); },
  async get(_scope: unknown, name: string) { return vaultData.get(name); },
} as unknown as VaultService;

try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const events: GitHubEvent[] = [];
  const source = new PollingGitHubSource(join(temp, 'github.json'), vault,
    async (event) => { events.push(event); }, fetch, base);
  await source.configure({ repositories: [{ name: 'acme/sample', ref: 'main' }] }, 'fake-test-token');
  assert.equal((await source.poll()).created, 3);
  assert.deepEqual(events.map((event) => event.kind), ['comment', 'comment', 'check']);
  assert.equal((events[0] as Extract<GitHubEvent, { kind: 'comment' }>).issue, 7);
  assert.equal((events[1] as Extract<GitHubEvent, { kind: 'comment' }>).issue, 8);
  assert.equal((await source.poll()).created, 0, 'GitHub event deduplication');
  assert.equal((await source.status()).hasToken, true);
  assert.equal(JSON.stringify(await source.status()).includes('fake-test-token'), false);
  await source.reply('acme/sample', 7, 'Safe approved report');
  const posted = requests.find((request) => request.method === 'POST');
  assert.equal(posted?.url, '/repos/acme/sample/issues/7/comments');
  assert.deepEqual(JSON.parse(posted.body), { body: 'Safe approved report' });
  assert.ok(requests.every((request) => request.token === 'Bearer fake-test-token'));
  assert.equal((await source.pullRequest({ repo: 'acme/sample', branch: 'neo/feature', commit: 'a'.repeat(40) }))?.number, 9);
  assert.equal(await source.pullRequest({ repo: 'acme/sample', branch: 'neo/feature', commit: 'b'.repeat(40) }), null);
  assert.equal(await source.pullRequest({ repo: 'acme/sample', branch: 'other', commit: 'a'.repeat(40) }), null);
  const beforeDenied = requests.length;
  await assert.rejects(source.pullRequest({ repo: 'other/private', branch: 'neo/feature', commit: 'a'.repeat(40) }), /unconfigured/);
  assert.equal(requests.length, beforeDenied);
  source.stop();
  const afterStop = requests.length;
  await source.poll();
  assert.equal(requests.length, afterStop);
  console.log('FAKE_GITHUB_SOURCE PASS issues/pr-comments/checks dedup vault reply stop');

  for (const blocked of [429, 403]) {
    status = blocked;
    const limited = new PollingGitHubSource(join(temp, `github-${blocked}.json`), vault, async () => {}, fetch, base);
    await limited.configure({ repositories: [{ name: 'acme/sample', ref: 'main' }] });
    await assert.rejects(limited.poll(), new RegExp(`HTTP ${blocked}`));
    const count = requests.length;
    const result = await limited.poll();
    assert.equal(result.checked, 0);
    assert.ok((result.pausedUntil ?? 0) > Date.now());
    assert.equal(requests.length, count, `no retry loop after ${blocked}`);
    limited.stop();
  }
  console.log('FAKE_GITHUB_RATE_LIMIT PASS 403/429 backoff no-tight-loop');

  for (const blocked of [429, 403]) {
    status = blocked;
    const scheduled = new PollingGitHubSource(join(temp, `scheduled-${blocked}.json`), vault, async () => {}, fetch, base);
    try {
      const before = requests.length;
      await scheduled.configure({ repositories: [{ name: 'acme/sample', ref: 'main' }] });
      // Let the real scheduled poll consume the error before there is an RPC caller.
      for (let attempt = 0; attempt < 200 && !(await scheduled.status()).pausedUntil; attempt++) await sleep(5);
      assert.ok((await scheduled.status()).pausedUntil);
      await sleep(0);
      await assert.rejects(scheduled.poll(), new RegExp(`HTTP ${blocked}`));
      assert.equal((await scheduled.poll()).checked, 0);
      assert.equal(requests.length, before + 1, 'Observing a scheduled error never retries HTTP');
    } finally { scheduled.stop(); }
  }

  status = 429;
  let requested!: () => void; let release!: () => void;
  const started = new Promise<void>(done => { requested = done; });
  const gate = new Promise<void>(done => { release = done; });
  beforeResponse = async () => { requested(); await gate; };
  const joined = new PollingGitHubSource(join(temp, 'joined-429.json'), vault, async () => {}, fetch, base);
  try {
    const before = requests.length;
    await joined.configure({ repositories: [{ name: 'acme/sample', ref: 'main' }] });
    await started;
    const explicit = joined.poll();
    release();
    await assert.rejects(explicit, /HTTP 429/);
    assert.equal((await joined.poll()).checked, 0, 'A caller that joins the scheduled failure already observed it');
    assert.equal(requests.length, before + 1, 'Joining a scheduled poll never adds a concurrent HTTP request');
  } finally { release(); joined.stop(); beforeResponse = async () => {}; }
  console.log('FAKE_GITHUB_SCHEDULED_ERROR PASS unobserved_429_403=reported_once joined_error=not_replayed no_extra_HTTP=true');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
