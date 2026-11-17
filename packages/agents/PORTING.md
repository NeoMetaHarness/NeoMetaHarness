# bot-hq domain adoption (P2-1)

Upstream: `nickvasilescu/bot-hq` at commit `decf9a215cddd8792a5f20f4a11a87d4dffa6d15` (MIT, Copyright (c) 2026 Nick Vasilescu).

This is a first-party, typed TypeScript adaptation of the domain behavior. The reference code was inspected at the pinned commit. No upstream runtime is imported.

| Neo file | bot-hq reference (path at pinned commit) | Adaptation |
|---|---|---|
| `src/runtime.ts` | `server/src/agent/loop.ts`, `server/src/types.ts` | Defines `AgentRuntime` (start, async event stream, approve, stop, cron). Removes direct Hermes endpoints and UI event dependencies so any agent-runtime extension can implement the interface. |
| `src/service.ts` (turns) | `server/src/agent/loop.ts` (`enqueue`, `runInBotQueue`, `requestApproval`, `resolveApproval`) | Per-bot serialized promise queues, cross-bot parallelism, persisted turn states/events and approval decisions. Pending approvals and active turns become interrupted after restart. |
| `src/service.ts` (rooms) | `server/src/agent/rooms.ts` (`createRoom`, `dispatchRoomMessage`, `postToRoom`) | Explicit room/membership records and fan-out through the same turn queue. No fixed bot or responder count and no prompt tied to the old bot-hq tools. |
| `src/service.ts` (tasks) | `server/src/agent/tools.ts` (`create_task`, `update_task`), `server/src/types.ts` | CRUD domain methods backed by Kysely with typed task states, ready to bridge to Hermes kanban. |
| `src/service.ts` (routines) | `server/src/routines.ts`, `server/src/agent/tools.ts` (`create_routine`, `update_routine`) | Maps enabled schedules to runtime cron, restores registrations at startup, and enqueues each firing as a typed routine turn. Scheduling is delegated to the runtime. |
| `../db/src/agent-records.ts` | `server/src/db.ts` (`bots`, `rows`, `approvals`, `routines`, `tasks`) | Own `agent_*` tables and idempotent Kysely migration on the existing Neo SQLite provider, with ordered stream-event records and restart-safe approval states. |
| `src/fake-agent-runtime.ts`, `test/agents.test.ts` | `server/src/agent/loop.ts` (runtime/approval sequence) | Fake async engine, manual concurrency gates, approvals, cron, restart and persistence tests. No user credentials or live model. |

Dropped from the source: bot-hq's Express server, front-end, Orgo screens, Composio and xAI integrations, embedded Hermes transport, local Cron instance, custom auth, per-bot gateway processes, memory/skills and voice files. These belong to independent Neo services or extensions.

The existing `THIRD_PARTY_NOTICES.md` has a placeholder. The PM owns that root file. Replace its bot-hq table cell with the pinned reference and append the **complete MIT License text** from `bot-hq/LICENSE` at the above commit, including the copyright line. No root files are changed in this branch.

Reproduce on the workspace branch using `pnpm --dir packages/agents test` (twice). Run `pnpm --dir packages/vault test` and the P1 regression suites to check the shared DB migration. The root lockfile must be reconciled by the PM when this package is merged.
