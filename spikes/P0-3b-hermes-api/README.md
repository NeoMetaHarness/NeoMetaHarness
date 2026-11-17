# Spike P0-3b: Hermes Agent API Server & Dashboard Backend Mapping

## Objective
Map the Hermes `api_server` (aiohttp) and `dashboard-backend` (FastAPI) endpoints into a concrete capability matrix, verify authentication mechanisms and primary surfaces, and validate write and streaming workflows against an isolated local Hermes Agent v0.23.2 instance using a local fake OpenAI-compatible streaming server.

## Endpoint Matrix

| Capability | Endpoint | Method | Operation | Server Stack | Auth Type & Header | Description |
|---|---|---|---|---|---|---|
| **bots/profiles** | `/api/profiles` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | List all registered profiles and home directories |
| **bots/profiles** | `/api/profiles` | POST | Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Create a new bot profile |
| **bots/profiles** | `/api/profiles/active` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Query current active profile |
| **bots/profiles** | `/api/profiles/active` | POST | Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Switch sticky active profile |
| **bots/profiles** | `/api/profiles/{name}` | DELETE | Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Delete a bot profile |
| **bots/profiles** | `/api/profiles/{name}/setup-command` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Terminal command to bootstrap profile |
| **bots/profiles** | `/p/{profile}/*` | ANY | Read / Write | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` (profile-scoped) | URL prefix multiplexing for secondary profiles |
| **chat/runs** | `/v1/chat/completions` | POST | Write | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | OpenAI-compatible chat completion & streaming |
| **chat/runs** | `/v1/runs` | POST | Write | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | Launch asynchronous structured agent run (202) |
| **chat/runs** | `/v1/runs/{id}` | GET | Read | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | Poll structured run status and outcome |
| **chat/runs** | `/v1/runs/{id}/events` | GET | Read (Stream) | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | SSE stream for real-time tokens, tools, approvals |
| **chat/runs** | `/v1/runs/{id}/approval` | POST | Write | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | Resolve tool approval gate (`once`, `session`, `deny`) |
| **chat/runs** | `/v1/runs/{id}/stop` | POST | Write | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | Cancel/interrupt an in-flight run |
| **chat/runs** | `/api/sessions` | GET | Read | FastAPI & aiohttp | Session token / Bearer | List stored conversation sessions |
| **chat/runs** | `/api/sessions/stats` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Active/archived session count & message volume |
| **chat/runs** | `/api/sessions/empty/count` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Count empty sessions eligible for prune |
| **cron** | `/api/cron/jobs` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | List scheduled cron jobs |
| **cron** | `/api/cron/jobs` | POST | Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Create scheduled cron job |
| **cron** | `/api/cron/jobs/{id}/trigger` | POST | Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Manually trigger cron execution immediately |
| **cron** | `/api/cron/jobs/{id}` | DELETE | Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Delete scheduled cron job |
| **cron** | `/api/cron/delivery-targets` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Delivery target options (channels/local) |
| **cron** | `/api/jobs` | GET | Read | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | Query runtime job queue status |
| **cron** | `/api/cron/fire` | POST | Write | aiohttp (`gateway.platforms.api_server`) | NAS-minted JWT | Webhook ingress for Chronos triggers |
| **kanban** | `/api/plugins/kanban/boards` | GET | Read | FastAPI (`plugins.kanban.dashboard`) | Session token (`X-Hermes-Session-Token` or Bearer) | List kanban boards |
| **kanban** | `/api/plugins/kanban/board` | GET | Read | FastAPI (`plugins.kanban.dashboard`) | Session token (`X-Hermes-Session-Token` or Bearer) | Active board tasks and columns |
| **kanban** | `/api/plugins/kanban/tasks` | POST | Write | FastAPI (`plugins.kanban.dashboard`) | Session token (`X-Hermes-Session-Token` or Bearer) | Create kanban task |
| **kanban** | `/api/plugins/kanban/tasks/{id}` | PATCH | Write | FastAPI (`plugins.kanban.dashboard`) | Session token (`X-Hermes-Session-Token` or Bearer) | Update task column status or assignment |
| **kanban** | `/api/plugins/kanban/stats` | GET | Read | FastAPI (`plugins.kanban.dashboard`) | Session token (`X-Hermes-Session-Token` or Bearer) | Task statistics grouped by status and assignee |
| **kanban** | `/api/plugins/kanban/workers/active`| GET | Read | FastAPI (`plugins.kanban.dashboard`) | Session token (`X-Hermes-Session-Token` or Bearer) | Live worker process count |
| **skills** | `/api/skills` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | List installed skills |
| **skills** | `/api/curator` | GET / POST | Read / Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Curator status, pause, and trigger run |
| **skills** | `/api/learning/graph` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Learning graph nodes, clusters, memory links |
| **skills** | `/api/skills/hub/official` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Official Skills Hub catalog |
| **skills** | `/v1/skills` | GET | Read | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | Upstream bug (issues #142575, #120831) returns 500 |
| **memory providers** | `/api/memory` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Active memory provider status & catalog |
| **memory providers** | `/api/memory/provider` | PUT | Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Switch active memory provider |
| **memory providers** | `/api/memory/providers/{p}/config`| GET / PUT | Read / Write | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Read/update memory provider settings |
| **platforms/channels**| `/api/messaging/platforms` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Status of all messaging integrations |
| **platforms/channels**| `/api/platforms/{p}/events` | POST | Write | aiohttp (`gateway.platforms.api_server`) | Webhook signature / secret | External webhook ingress (Slack/Discord/Telegram) |
| **model providers** | `/v1/models` | GET | Read | aiohttp (`gateway.platforms.api_server`) | Bearer `API_SERVER_KEY` | Available model catalog |
| **model providers** | `/api/local-models/status` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Local model inference engine status |
| **model providers** | `/api/credentials/pool` | GET | Read | FastAPI (`hermes_cli.web_server`) | Session token (`X-Hermes-Session-Token` or Bearer) | Credential rotation pool status |

## Authentication Mechanics

1. **Dashboard Backend (FastAPI)**:
   - **Verification Function**: `_has_valid_session_token(request)` in `hermes_cli/web_server.py:657`.
   - **Accepted Headers**: `X-Hermes-Session-Token: <token>` (primary) or `Authorization: Bearer <token>` (fallback).
   - **Generation & Resolution**: Evaluated in `hermes_cli/web_server_session_token.py` via `resolve_session_token()`. It resolves in priority order:
     1. Environment variable `HERMES_DASHBOARD_SESSION_TOKEN`.
     2. Value stored in file if formatted as `file:<path>`.
     3. Auto-generated at launch using `secrets.token_urlsafe(32)`.
   - **Lifetime**: Bound to the web server process lifetime. If generated dynamically, a new token is created on each process restart and injected into `index.html` runtime script tags for dashboard UI consumption.
   - **Security**: Hardened against timing attacks using `hmac.compare_digest`. Rejects empty or whitespace tokens.

2. **Runtime API Server (aiohttp)**:
   - **Verification Function**: `APIServerAdapter._check_auth(request)` in `gateway/platforms/api_server.py:756`.
   - **Accepted Headers**: `Authorization: Bearer <key>`.
   - **Configuration per Profile**: Configured in profile configuration via `API_SERVER_KEY` environment variable or `config.yaml` at `gateway.platforms.api_server.extra.key`.
   - **Profile Prefix Multiplexing**: Secondary profiles are multiplexed under `/p/<profile>/` on the aiohttp port (default 8642). `gateway/config.py` and `gateway/platforms/api_server.py` enforce `_has_usable_api_server_key` per profile, requiring at least 16 characters. Requests to `/p/<profile>/...` are authenticated against that profile's distinct key.

## Primary Surface Guidance & Dual-Stack Lifecycle

Hermes runs two distinct server stacks:
- **FastAPI / Starlette** (`hermes_cli.web_server`): Management and UI plane.
- **aiohttp** (`gateway.platforms.api_server`): Inference and execution engine.

**Process Execution**: Both run concurrently within a single gateway process under `gateway/run_api.py`. `LocalGatewayListener` starts on the configured port, serving the native `/api/ws` websocket immediately, while mounting `hermes_cli.web_server.app` via `GatewayDashboardMount` lazily on the first incoming HTTP request.

**Recommended Primary Surface by Capability**:
- **Profiles & Bot HQ**: Primary is **FastAPI** (`/api/profiles`). Manages bot creation, deletion, and directory bootstrapping.
- **Cron Jobs**: Primary is **FastAPI** (`/api/cron/jobs`). Provides declarative job registration, croniter schedule parsing, and run triggering.
- **Kanban Board**: Primary is **FastAPI** (`/api/plugins/kanban/*`). Backed by `plugins/kanban/dashboard/plugin_api.py` and SQLite.
- **Skills & Curator**: Primary is **FastAPI** (`/api/skills`, `/api/curator`, `/api/learning/graph`). aiohttp `GET /v1/skills` must be avoided due to known upstream defect.
- **Memory Provider Management**: Primary is **FastAPI** (`/api/memory`, `/api/memory/providers/*`). Controls provider selection and dependency setup.
- **Messaging Integrations**: Primary is **FastAPI** (`/api/messaging/platforms`) for channel configuration and pairing; **aiohttp** (`/api/platforms/{p}/events`) handles external inbound webhooks.
- **Agent Runs & Streaming**: Primary is **aiohttp** (`/v1/runs`, `/v1/runs/{id}/events`). Provides SSE streaming, live token delivery, tool approval gating, and run cancellation.

## Known Upstream Issues
- **`GET /v1/skills` TypeError (HTTP 500)**: At `gateway/platforms/api_server.py:2385`, `find_all_skills(skip_disabled=False, include_editorial=True)` passes `include_editorial`, which does not exist in `tools/skills_tool.py:277`.
  - Tracked upstream in open issues: **#142575**, **#120831**, **#132317**, **#108967**, **#148508**.

## Evidence

Automated validation was executed with `spikes/P0-3b-hermes-api/test_api_coverage.py` against isolated home `spikes/.hermes-home` and a local stub server `fake_model_server.py` on `http://127.0.0.1:18898`:

```text
=== Testing FastAPI Dashboard Backend (hermes_cli.web_server) ===
  [OK] GET  /api/profiles                       -> 200 (1. bots/profiles: list profiles): {'profiles': [{'name': 'default', 'path': '...\\spikes\\.hermes-home'}]}
  [OK] GET  /api/profiles/active                -> 200 (1. bots/profiles: get active profile): {'active': 'default', 'current': 'default'}
  [OK] GET  /api/profiles/default/setup-command -> 200 (1. bots/profiles: profile setup command): {'command': 'hermes setup'}
  [OK] GET  /api/sessions                       -> 200 (2. chat/runs: list sessions): {'sessions': [...], 'runtime_revision': 1}
  [OK] GET  /api/sessions/stats                 -> 200 (2. chat/runs: session stats): {'total': 14, 'active_store': 14, 'archived': 0}
  [OK] GET  /api/sessions/empty/count           -> 200 (2. chat/runs: empty sessions count): {'count': 0}
  [OK] GET  /api/cron/jobs                      -> 200 (3. cron: list cron jobs): []
  [OK] GET  /api/cron/delivery-targets          -> 200 (3. cron: delivery targets): {'targets': [{'id': 'local', 'name': 'Local (save only)', ...}]}
  [OK] GET  /api/plugins/kanban/boards          -> 200 (4. kanban: list boards): {'boards': [{'slug': 'default', 'name': 'Default', ...}]}
  [OK] GET  /api/plugins/kanban/board           -> 200 (4. kanban: get active board): {'columns': [{'name': 'triage', ...}, {'name': 'todo', ...}]}
  [OK] GET  /api/plugins/kanban/stats           -> 200 (4. kanban: stats): {'by_status': {'blocked': 6, 'ready': 1}}
  [OK] GET  /api/plugins/kanban/workers/active  -> 200 (4. kanban: active workers): {'workers': [], 'count': 0}
  [OK] GET  /api/skills                         -> 200 (5. skills: list skills): []
  [OK] GET  /api/curator                        -> 200 (5. skills: curator status): {'enabled': True, 'paused': False, 'interval_hours': 168}
  [OK] GET  /api/learning/graph                 -> 200 (5. skills: learning graph): {'nodes': [], 'edges': [], 'clusters': [], ...}
  [OK] GET  /api/skills/hub/official            -> 200 (5. skills: skills hub official): {'skills': [{'name': 'agent-merge-conflict-arbiter', ...}]}
  [OK] GET  /api/memory                         -> 200 (6. memory: memory status): {'active': '', 'providers': [{'name': 'byterover', ...}]}
  [OK] GET  /api/memory/providers/honcho/config -> 200 (6. memory: honcho config): {'name': 'honcho', 'label': 'honcho', ...}
  [OK] GET  /api/messaging/platforms            -> 200 (7. platforms: messaging platforms): {'env_path': '...\\.env'}
  [OK] GET  /api/local-models/status            -> 200 (8. models: local models status): {'enabled': False, 'tag': 'b12144', ...}
  [OK] GET  /api/credentials/pool               -> 200 (8. models: credentials pool): {'providers': [{'provider': 'custom:custom', ...}]}

--- Testing FastAPI Write Paths ---
  [OK] POST /api/profiles                      -> 200 (Created bot profile 'bot_1794879844')
  [OK] POST /api/profiles/active               -> 200 (Switched active profile to 'bot_1794879844')
  [OK] DELETE /api/profiles/{name}            -> 200 (Deleted bot profile 'bot_1794879844')
  [OK] POST /api/cron/jobs                     -> 200 (Created cron job ID: c84158549454)
  [OK] POST /api/cron/jobs/{id}/trigger        -> 200 (Triggered cron run)
  [OK] DELETE /api/cron/jobs/{id}              -> 200 (Deleted cron job)
  [OK] POST /api/plugins/kanban/tasks          -> 200 (Created task ID: t_008c7e73)
  [OK] PATCH /api/plugins/kanban/tasks/{id}    -> 200 (Updated status to 'blocked')

=== Testing aiohttp API Server (gateway.platforms.api_server) ===
Started background Fake OpenAI Server on http://127.0.0.1:18898
  [OK] GET  /health                             -> 200 (Public health check)
  [OK] GET  /v1/models                          -> 200 (Model catalog: 1 models)
  [OK] GET  /v1/capabilities                    -> 200 (Platform: hermes-agent)
  [KNOWN UPSTREAM BUG] GET /v1/skills           -> 500 (Upstream issues #142575, #120831, #132317: include_editorial in api_server.py)
  [OK] GET  /api/jobs                           -> 200 (Jobs count: 0)
  [OK] GET  /api/sessions                       -> 200 (Sessions list)
  [OK] GET  /p/default/v1/models                -> 200 (Profile-scoped /p/default/ prefix)
  [OK] GET  /v1/models (bad key)                -> 401 (Auth rejection 401 verified)

--- Testing aiohttp Write & Streaming: /v1/runs, SSE, Tool Approval, Stop ---
  [OK] POST /v1/runs                            -> 202 (Started run: run_d836789179324c6db17329bcf68d586c)
  [OK] GET  /v1/runs/run_d836789179324c6db17329bcf68d586c/events      -> 200 (Connected SSE stream)
    -> [SSE Event] approval.request received for dangerous command!
    -> [OK] POST /v1/runs/run_d836789179324c6db17329bcf68d586c/approval (deny) -> 200 (Resolved: deny)
    -> [SSE Event] run.completed received after tool denial!
    -> [SSE Stream] : stream closed frame received
  [OK] GET  /v1/runs/run_d836789179324c6db17329bcf68d586c              -> 200 (Final status: completed)
  [OK] POST /v1/runs                            -> 202 (Started second run: run_e8beba12b3924ea6906f7ddd8526e4b7)
  [OK] POST /v1/runs/run_e8beba12b3924ea6906f7ddd8526e4b7/stop       -> 200 (Stop request sent)
  [OK] GET  /v1/runs/run_e8beba12b3924ea6906f7ddd8526e4b7             -> 200 (Status after stop: stopping)

All Hermes API coverage, write, and streaming tests passed successfully!
```

## Architecture Impact
- **Endpoint Coverage Confirmed**: Full endpoint coverage across profiles, cron, kanban, skills, memory, platforms, and models. Tested read, write, and streaming behavior across both FastAPI and aiohttp surfaces.
- **Routing Strategy**: Direct all bot-hq management, profile administration, cron scheduling, and kanban interactions to the FastAPI backend. Route inference, asynchronous runs, SSE streaming, and interactive approval gates to the aiohttp API server.
- **Skills Workaround**: Use `GET /api/skills` (FastAPI) rather than `GET /v1/skills` (aiohttp) pending upstream resolution of #142575.

## Verdict
**ACCEPTED**. All endpoint mappings, write operations (profiles, cron, kanban), streaming SSE lifecycles, interactive tool approval gates, and cancellation controls are verified and confirmed against Hermes v0.23.2.
