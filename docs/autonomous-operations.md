# Autonomous Operations and Superagent Inbox

Neo Meta Harness pairs specialized worker engines with an autonomous superagent orchestrator (`extensions/engine-superagent/src/index.ts`, `docs/02-architecture.md:213-225`). The superagent ingests requests from multiple sources (desktop shell, cron schedules, messaging channels, repository comments, check runs), dispatches work through model routing and MCP tools, and routes proposals into the Astryx Inbox.

## Accept modes and Suggestions lane (P6-6)

For inferred source work (such as `@neo` comments in repository code, GitHub issue mentions, or failing CI check runs), workspace autonomy is controlled by configurable accept modes (`packages/contracts/src/index.ts:605-630`, `docs/02-architecture.md:216`).

### Three accept modes

Workspace autonomy is governed by three distinct modes:

1. **`observe` (default):**
   - Inferred work is evaluated and converted into an Inbox *Suggestion* (`status: 'suggestion'`).
   - Work does not start until a workspace member explicitly clicks **Accept**. Any member can also dismiss the suggestion.
2. **`act-with-approval`:**
   - Inferred work begins execution automatically.
   - Any outward-facing result (such as posting a comment, pushing code, or triggering a release) is staged and paused for human sign-off (`status: 'approval'`).
3. **`act`:**
   - Work starts immediately and executes autonomously through delivery, subject to ceiling policies.

### Destructive work safeguard

Regardless of the active workspace accept mode, destructive actions are subject to strict privilege checks:

- Any task involving destructive operations (such as code deletion, database modifications, or upstream dependency bumps) is always assigned `destructive: true` and created as a Suggestion (`apps/gateway/src/server.ts:478-485`, `apps/neo-app/src/pages/Inbox.tsx:86-106`).
- Accepting a destructive suggestion requires an `admin` or `owner` role. If a non-admin member attempts to accept a destructive item, the Gateway rejects the request with an authorization error.

### Suggestions UI in Astryx Inbox

In the Astryx frontend (`apps/neo-app/src/pages/Inbox.tsx:86-106`), Suggestions are displayed in a dedicated lane:

- **Card elements:** Displays source badge (`neo/github`, `neo/upstream`, etc.), report summary, proposed changes, risks, and validation tests.
- **Actions:** Provides **Accept** and **Dismiss** controls.
- **Playbook suggestions:** When successful resolution episodes match repeating operational patterns, the system surfaces a playbook suggestion (`apps/neo-app/src/pages/Inbox.tsx:211-217`) proposing skill registry assignment.

### Decision logging and evaluation traces

The superagent logs all evaluation decisions for observability and model training:

- **Query endpoint:** `inbox.decisions.list({ ticketId?, limit? })` (`packages/contracts/src/index.ts:649-650`, `apps/gateway/src/server.ts:472-475`).
- **Trace schema:** Every decision records `trace_id`, `ticketId`, `source`, `inputsSummary`, `candidates`, `chosenAction`, `modelRole` (`'eval'` or `'coding'`), `model_id`, `ranking`, `latencyMs`, and execution `outcome` (`packages/contracts/src/index.ts:635-645`).

### Admin accept mode configuration

- **Query mode:** `inbox.acceptMode.get()` (available to all workspace viewers per `apps/gateway/src/policy.ts:210`).
- **Update mode:** `inbox.acceptMode.set({ mode })` (restricted to `admin` role per `apps/gateway/src/policy.ts:211`).

## Upstream self-maintenance routine (P6-8)

Neo maintains its own dependencies using the `neo upstream` superagent routine (`extensions/engine-superagent/src/upstream-source.ts`, `extensions/engine-superagent/src/index.ts:680-735`).

### Upstream checker and drift detection

The routine compares the repository's pinned dependencies in `upstream.lock.json` against release sources defined in `upstream/registry.yaml`:

- **Execution:** Production runs `pnpm upstream:check --json` via `scripts/upstream.mjs` (`extensions/engine-superagent/src/upstream-source.ts:23-38`). This performs read-only checks and never writes to disk or external repositories.
- **Test injection:** Automated tests inject an in-memory `UpstreamChecker` implementation via `NMH_SUPERAGENT_TEST_UPSTREAM` without network calls.
- **Drift statuses:** Flags entries as `bump available`, `review`, or `unpinned`.

### Suggestion generation and approval-only bumps

When drift is detected:

1. **Proposal card:** The routine creates an Inbox Suggestion with `source: 'neo/upstream'`, `status: 'suggestion'`, and `destructive: true`.
2. **Review in observe mode:** In `observe` mode, it generates a proposal card detailing pinned version, latest version, and changelog link. In `act` or `act-with-approval` modes, the configured bot can additionally run an automated read-only compatibility review.
3. **Approval-only bumps:** Neo never applies upstream bumps autonomously. Approving an upstream bump requires an `admin` or `owner` role, and requires a configured worker bot (`botId`) (`extensions/engine-superagent/src/index.ts:717-724`).
4. **Execution:** Once approved, the configured bot executes the bump as a supervised ticket.

### Configuration and routine state

- **Assign maintenance bot:** `inbox.upstream.configure({ botId: string | null })` (`packages/contracts/src/index.ts:664-665`, `apps/gateway/src/server.ts:522-525`, requires `admin` role).
- **Inspect routine status:** `inbox.upstream.status()` queries the persisted `UpstreamRoutineStore`, returning `botId`, `lastCheckedAt`, `lastDrift`, and `lastError` (`extensions/engine-superagent/src/upstream-source.ts:40-58`).

## WhatsApp completion notifications (P6-9)

Neo supports asynchronous completion alerts sent to messaging platforms, enabling operators to trigger long-running workflows and receive notifications when tasks finish.

### Decoupled ChannelBus rendezvous

The Gateway hosts a decoupled message rendezvous (`apps/gateway/src/channel-bus.ts:23-70`):

- **Decoupled lifecycle:** Bridges messaging platform integrations (such as the WhatsApp slice in `extensions/channels`) and the Inbox `neo/channel` source. Either side can be enabled or disabled dynamically without holding stale references.
- **Registration:** Platform slices register via `ChannelBus.attach(id, platform)`.

### Notification delivery lifecycle

When an operator submits a task requesting completion notification:

1. **Request payload:** `inbox.ask({ text, botId, notify: { channel: 'whatsapp', recipient: '+15551234567' } })`.
2. **Recipient resolution:** The Gateway validates the recipient number against authorized profiles and member roles via `/x/channels/notification/resolve` (`apps/gateway/src/server.ts:1388`, `docs/testing/p6-9.md:32-35`).
3. **Execution & delivery:** Upon task completion, the superagent formats the report and calls `ChannelBus.reply({ channelId: 'whatsapp:<phone>', requireDelivery: true, ... })`.
4. **Live transport requirement:** Setting `requireDelivery: true` enforces that a live platform transport must deliver the message. If the platform is unavailable, delivery throws `Channel platform unavailable` (`apps/gateway/src/channel-bus.ts:53`) instead of falling back to a test sink.
5. **Replay prevention:** Successful delivery records `notification.deliveredAt` in the persisted inbox record (`packages/contracts/src/index.ts:614`, `docs/testing/p6-9.md:20-22`). Acknowledged notifications are persisted and never replayed when the Gateway restarts.

### Cleanup on disable

When the Channels extension is disabled or detached, its platform entry is removed from `ChannelBus`. Any subsequent delivery attempts fail cleanly with explicit errors, preventing orphaned processes or message loops.
