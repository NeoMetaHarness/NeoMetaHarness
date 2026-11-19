import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** First-party tools call existing Gateway contracts; engines remain unmodified. */
export function registerWorkflowTools(server, client, snapshot) {
  const tool = (name, description, inputSchema, run) => server.registerTool(name, { description, inputSchema }, async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await run(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: String(error.message ?? error) }] }; }
  });
  tool('coding.projects', 'List T3 projects before delegating coding. Use an existing project id.', z.object({}), async () => {
    const { projects } = await client.x['engine-t3'].threads.list();
    return { summary: `${projects.length} coding projects available`, projects };
  });
  tool('coding.build', 'Build a feature with the configured neo-coding DSH provider in a new T3 thread and worktree. Prepare a local commit and PR description only; never push or publish a PR.', z.object({
    projectId: z.string().min(1), text: z.string().min(1), title: z.string().min(1).max(200),
    branch: z.string().min(1).max(160), files: z.array(z.string().min(1)).min(1).max(100), description: z.string().max(20000),
  }), async ({ projectId, text, title, branch, files, description }) => {
    const threadId = randomUUID();
    // engine-t3 uses pinned orchestrationV2 ThreadCreate/Send and subscribes to
    // runs via orchestration.subscribeThread; coding-workflow owns ACP + local git.
    await client.x['engine-t3'].create({ projectId, threadId, title, providerId: 'neo-coding', model: 'default' });
    try {
      const worktree = await client.x['coding-workflow'].worktree({ threadId, branch });
      await client.x['engine-t3'].send({ threadId, text });
      const end = Date.now() + 120000;
      for (;;) {
        const projection = await snapshot(threadId);
        const runs = projection.runs ?? [];
        if (runs.some(run => ['failed', 'cancelled', 'interrupted'].includes(run.status))) throw new Error('Coding run did not complete');
        if (runs.length && runs.every(run => run.status === 'completed')) break;
        if (Date.now() > end) throw new Error('Coding run timed out');
        await new Promise(done => setTimeout(done, 150));
      }
      const prepared = await client.x['coding-workflow'].prepare({ threadId, title, description, files });
      return { summary: `PR prepared locally on ${prepared.branch} at ${prepared.commit}; publication is not confirmed.`,
        threadId, worktree: worktree.path, ...prepared, tests: [], risks: ['Local preparation does not publish a PR.'] };
    } catch (error) { await client.x['engine-t3'].stop({ threadId }).catch(() => {}); throw error; }
  });
  tool('coding.pull_request', 'Confirm an open PR in a configured GitHub repository for the exact prepared branch and commit. Only a confirmed result means the PR is up. If absent, ask the user to publish and retry; never push.', z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.string().min(1).max(160), commit: z.string().regex(/^[a-f0-9]{40}$/),
  }), async args => {
    const pullRequest = await client.inbox.github.pullRequest(args);
    return pullRequest ? { summary: `PR is up: ${pullRequest.url}`, pullRequest, tests: [], risks: [] }
      : { summary: 'The local commit is ready, but no open PR for that commit is confirmed.', kind: 'question',
        question: 'Publish the prepared branch and PR, then reply to check again.' };
  });
  tool('memory.remember', 'Explicitly remember a user-requested fact in shared Neo workspace memory so later turns on other engines can recall it. Do not copy private bot memories or credentials.', z.object({ text: z.string().trim().min(1).max(16000) }), async ({ text }) => {
    const entry = await client.x['memory-local'].add({ workspace: 'default', subject: 'user', subjectId: 'global', text,
      source: 'superagent.remember', provenance: 'explicit user request through Neo worker MCP', trust: 'observed' });
    return { summary: `Remembered: ${text}`, memoryId: entry.id, tests: [], risks: [] };
  });
}
