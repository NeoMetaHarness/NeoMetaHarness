import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteDatabaseProvider } from '@neometaharness/db';
import { AgentService, fakeAgentRuntime } from '../src/index.js';

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Expected condition did not occur');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('P2-1 bots, queues, room fanout, approvals, tasks, routines, SQLite restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nmh-agents-'));
  const filename = join(dir, 'agent-state.db');
  let db = new SqliteDatabaseProvider(filename);
  const fake = fakeAgentRuntime();
  let service = new AgentService(db.agents, fake);
  try {
    await db.migrate();
    await service.start();
    const alpha = await service.createBot('Alpha');
    const beta = await service.createBot('Beta');
    assert.equal((await db.agents.listBots()).length, 2);

    // A1 and B1 run together; A2 is queued until A1 finishes.
    fake.setMode(alpha.id, 'manual');
    fake.setMode(beta.id, 'manual');
    const a1 = await service.send(alpha.id, 'first');
    const a2 = await service.send(alpha.id, 'second');
    const b1 = await service.send(beta.id, 'parallel');
    await until(() => fake.started.length === 2);
    assert.deepEqual(fake.started.map((run) => run.request.input), ['first', 'parallel']);
    assert.equal((await db.agents.getTurn(a2.turnId))?.status, 'queued');
    fake.finish(fake.started[1]!.runId, 'B1');
    await b1.done;
    assert.equal(fake.started.length, 2);
    fake.finish(fake.started[0]!.runId, 'A1');
    await a1.done;
    await until(() => fake.started.length === 3);
    assert.equal(fake.started[2]!.request.input, 'second');
    fake.finish(fake.started[2]!.runId, 'A2');
    await a2.done;
    assert.deepEqual((await db.agents.turnEvents(a1.turnId)).map((e) => e.kind), ['delta', 'completed', 'turn.status']);
    assert.equal((await db.agents.getTurn(a2.turnId))?.status, 'completed');

    fake.setMode(alpha.id, 'instant');
    fake.setMode(beta.id, 'instant');
    const room = await service.createRoom('Team', [alpha.id, beta.id, beta.id]);
    assert.equal((await db.agents.roomMembers(room.id)).length, 2);
    const fanout = await service.sendRoomMessage(room.id, 'How are we doing?');
    assert.equal(fanout.length, 2);
    await Promise.all(fanout.map((turn) => turn.done));
    assert.equal(fake.started.filter((run) => run.request.roomId === room.id).length, 2);
    await service.postToRoom(room.id, alpha.id, 'Progress posted');
    assert.equal((await db.agents.roomMessages(room.id)).length, 2);
    await assert.rejects(service.postToRoom(room.id, 'outsider', 'intrusion'), /not a room member/);

    fake.setMode(alpha.id, 'approval');
    const allowed = await service.send(alpha.id, 'Needs approval');
    await until(async () => (await db.agents.approvalsForTurn(allowed.turnId)).length === 1);
    const pending = (await db.agents.approvalsForTurn(allowed.turnId))[0]!;
    assert.equal((await db.agents.getTurn(allowed.turnId))?.status, 'awaiting_approval');
    assert.equal(await service.resolveApproval(pending.id, 'allow'), true);
    assert.equal(await service.resolveApproval(pending.id, 'allow'), false);
    await allowed.done;
    assert.equal((await db.agents.getApproval(pending.id))?.status, 'approved');
    assert.equal((await db.agents.getTurn(allowed.turnId))?.status, 'completed');

    const denied = await service.send(alpha.id, 'Denied operation');
    await until(async () => (await db.agents.approvalsForTurn(denied.turnId)).length === 1);
    const decline = (await db.agents.approvalsForTurn(denied.turnId))[0]!;
    assert.equal(await service.resolveApproval(decline.id, 'deny'), true);
    await denied.done;
    assert.equal((await db.agents.getTurn(denied.turnId))?.status, 'denied');
    assert.equal((await db.agents.getApproval(decline.id))?.status, 'denied');
    assert.ok(fake.stopped.length >= 1);

    const task = await service.createTask(beta.id, 'Review draft');
    assert.equal(await service.updateTask(task.id, 'working', 'Started'), true);
    assert.equal(await service.updateTask(task.id, 'done', 'Published'), true);
    assert.equal((await db.agents.listTasks(beta.id))[0]?.status, 'done');
    const routine = await service.createRoutine(beta.id, 'Morning sync', 'Summarize inbox', '0 9 * * *', 'Asia/Kolkata');
    assert.deepEqual(fake.schedules.get(routine.id)?.routine, {
      id: routine.id, botId: beta.id, schedule: '0 9 * * *', timezone: 'Asia/Kolkata',
      prompt: 'Summarize inbox',
    });
    await fake.fireRoutine(routine.id);
    assert.equal((await db.agents.getRoutine(routine.id))?.last_run_at === null, false);
    await service.setRoutineEnabled(routine.id, false);
    assert.equal(fake.schedules.has(routine.id), false);
    await service.setRoutineEnabled(routine.id, true);
    assert.equal(fake.schedules.has(routine.id), true);

    await service.dispose();
    await db.close();
    db = new SqliteDatabaseProvider(filename);
    await db.migrate();
    const recoveredRuntime = fakeAgentRuntime();
    service = new AgentService(db.agents, recoveredRuntime);
    await service.start();
    assert.equal((await db.agents.listBots()).length, 2);
    assert.equal((await db.agents.roomMembers(room.id)).length, 2);
    assert.equal((await db.agents.roomMessages(room.id)).length, 2);
    assert.equal((await db.agents.getTurn(allowed.turnId))?.status, 'completed');
    assert.equal((await db.agents.getApproval(pending.id))?.status, 'approved');
    assert.equal((await db.agents.listTasks(beta.id))[0]?.note, 'Published');
    assert.ok(recoveredRuntime.schedules.has(routine.id));
    await recoveredRuntime.fireRoutine(routine.id);
    assert.equal((await db.agents.listTurns(beta.id)).filter((turn) => turn.source === 'routine').length, 2);
    await service.dispose();
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart interrupts orphaned run and approval, and stopped queue item never starts', async () => {
  const db = new SqliteDatabaseProvider(':memory:');
  const fake = fakeAgentRuntime();
  const service = new AgentService(db.agents, fake);
  try {
    await db.migrate();
    await service.start();
    const bot = await service.createBot('Bot');
    fake.setMode(bot.id, 'manual');
    const run1 = await service.send(bot.id, 'active');
    const queued = await service.send(bot.id, 'queued');
    await until(() => fake.started.length === 1);
    await service.stopTurn(queued.turnId);
    fake.finish(fake.started[0]!.runId);
    await Promise.all([run1.done, queued.done]);
    assert.equal(fake.started.length, 1);
    assert.equal((await db.agents.getTurn(queued.turnId))?.status, 'stopped');
    const orphan = await service.send(bot.id, 'orphaned');
    await until(() => fake.started.length === 2);
    await db.agents.createApproval({
      id: 'orphan-approval', turn_id: orphan.turnId, request_id: 'lost-request',
      tool: 'delete', detail: 'Approval lost with process', status: 'pending',
      created_at: Date.now(), resolved_at: null,
    });
    await db.agents.setTurnStatus(orphan.turnId, 'awaiting_approval');
    // Simulate process exit: state is persisted, while a new process has no waiter.
    const newService = new AgentService(db.agents, fakeAgentRuntime());
    await newService.start();
    assert.equal((await db.agents.getTurn(orphan.turnId))?.status, 'interrupted');
    assert.equal((await db.agents.getApproval('orphan-approval'))?.status, 'interrupted');
    // End the fake old process's stream; a real previous process would be gone.
    await fake.stop(fake.started[1]!.runId);
    await orphan.done;
  } finally {
    await service.dispose();
    await db.close();
  }
});
