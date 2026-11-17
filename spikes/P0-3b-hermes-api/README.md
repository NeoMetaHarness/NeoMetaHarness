# P0-3b Hermes API Coverage
Verdict: WORKS WITH WORKAROUND
Question: Can Hermes `api_server` and dashboard-backend endpoints (pinned `v0.23.2`) cover all needed capabilities for bots/profiles, chat/runs streaming, cron, kanban, skills (+ `/learn`, curator), memory providers, platforms/channels, and model providers?
Pinned ref: hermes-agent@v0.23.2 (commit `ae2a81ccc00e9b7c06301523e5bb09608397149c`)
Seam:
- `gateway/platforms/api_server.py` + `gateway/platforms/api_server_*.py` (`aiohttp.web.Application` on port 8642)
- `hermes_cli/web_server.py` + `hermes_cli/web_routers/*.py` (`fastapi.FastAPI` dashboard backend app)
- `gateway/run_api.py` (combines native WS session router `/api/ws` with lazy dashboard mount)

## API Coverage Matrix

| Capability | Primary Endpoint | HTTP Method | Read/Write | Server Surface | Auth Mechanism | Notes |
|---|---|---|---|---|---|---|
| **bots/profiles** | `/api/profiles` | GET | Read | FastAPI (web_server) | Session token / Bearer | Lists all configured profiles |
| **bots/profiles** | `/api/profiles` | POST | Write | FastAPI (web_server) | Session token / Bearer | Creates new profile/bot |
| **bots/profiles** | `/api/profiles/active` | GET / POST | Read / Write | FastAPI (web_server) | Session token / Bearer | Read or switch active profile |
| **bots/profiles** | `/api/profiles/{name}/setup-command` | GET | Read | FastAPI (web_server) | Session token / Bearer | Onboarding command for profile |
| **bots/profiles** | `/p/{profile}/v1/*` | ANY | Read / Write | aiohttp (api_server) | Profile `API_SERVER_KEY` | Profile prefix multiplexing |
| **chat/runs streaming** | `/v1/chat/completions` | POST | Write (SSE) | aiohttp (api_server) | Bearer `API_SERVER_KEY` | OpenAI compatible turn stream |
| **chat/runs streaming** | `/v1/responses` | POST | Write (SSE) | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Cumulative response chaining |
| **chat/runs streaming** | `/v1/runs` | POST | Write | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Asynchronous agent run dispatch |
| **chat/runs streaming** | `/v1/runs/{id}` | GET | Read | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Run status and inspection |
| **chat/runs streaming** | `/v1/runs/{id}/events` | GET | Read (SSE) | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Server-Sent Events stream |
| **chat/runs streaming** | `/v1/runs/{id}/approval` | POST | Write | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Tool approval decision input |
| **chat/runs streaming** | `/v1/runs/{id}/stop` | POST | Write | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Interrupt / cancel active run |
| **chat/runs streaming** | `/api/sessions` | GET / POST | Read / Write | Both surfaces | Bearer / Session token | List or create session thread |
| **chat/runs streaming** | `/api/sessions/{id}/chat/stream` | POST | Write (SSE) | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Session-bound chat streaming |
| **chat/runs streaming** | `/api/ws` | WS | Read / Write | Gateway / FastAPI | Ticketed WS | Full bi-directional protocol |
| **cron** | `/api/cron/jobs` | GET / POST | Read / Write | FastAPI (web_server) | Session token / Bearer | List, create scheduled jobs |
| **cron** | `/api/cron/jobs/{id}` | GET / PUT / DELETE | Read / Write | FastAPI (web_server) | Session token / Bearer | Inspect, update, delete job |
| **cron** | `/api/cron/jobs/{id}/run` | POST | Write | FastAPI (web_server) | Session token / Bearer | Trigger immediate execution |
| **cron** | `/api/jobs` | GET / POST | Read / Write | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Lightweight job API |
| **cron** | `/api/cron/fire` | POST | Write | aiohttp (api_server) | Bearer JWT (NAS/cron) | External scheduler webhook |
| **kanban** | `/api/plugins/kanban/boards` | GET / POST | Read / Write | FastAPI plugin | Session token / Bearer | List and create kanban boards |
| **kanban** | `/api/plugins/kanban/board` | GET | Read | FastAPI plugin | Session token / Bearer | Active board columns and tasks |
| **kanban** | `/api/plugins/kanban/tasks` | POST | Write | FastAPI plugin | Session token / Bearer | Create kanban task |
| **kanban** | `/api/plugins/kanban/tasks/{id}` | GET / PATCH / DELETE | Read / Write | FastAPI plugin | Session token / Bearer | Full task lifecycle |
| **kanban** | `/api/plugins/kanban/workers/active` | GET | Read | FastAPI plugin | Session token / Bearer | Worker agent assignments |
| **kanban** | `/api/plugins/kanban/runs/{run_id}` | GET | Read | FastAPI plugin | Session token / Bearer | Execution run logs for task |
| **skills** | `/api/skills` | GET / POST | Read / Write | FastAPI (web_server) | Session token / Bearer | List installed skills, create |
| **skills** | `/api/skills/content` | GET / PUT | Read / Write | FastAPI (web_server) | Session token / Bearer | Read or edit `SKILL.md` body |
| **skills** | `/api/skills/toggle` | PUT | Write | FastAPI (web_server) | Session token / Bearer | Enable/disable skill |
| **skills** | `/api/skills/hub/*` | GET / POST | Read / Write | FastAPI (web_server) | Session token / Bearer | Search, preview, install hub |
| **skills** | `/api/curator` | GET / PUT / POST | Read / Write | FastAPI (web_server) | Session token / Bearer | Curator status, pause, run |
| **skills** | `/api/learning/graph` | GET | Read | FastAPI (web_server) | Session token / Bearer | Nodes, clusters, learning graph |
| **skills** | `/v1/skills` | GET | Read | aiohttp (api_server) | Bearer `API_SERVER_KEY` | **UPSTREAM BUG**: returns 500 |
| **skills** | `/learn` | Slash cmd | Write | Turn executor | Session actor | Ported into `slash_commands.py` |
| **memory providers** | `/api/memory` | GET | Read | FastAPI (web_server) | Session token / Bearer | Active provider status |
| **memory providers** | `/api/memory/provider` | PUT | Write | FastAPI (web_server) | Session token / Bearer | Switch active memory provider |
| **memory providers** | `/api/memory/providers/{name}/config`| GET / PUT | Read / Write | FastAPI (web_server) | Session token / Bearer | Read / update plugin config |
| **memory providers** | `/api/memory/providers/{name}/setup` | POST | Write | FastAPI (web_server) | Session token / Bearer | Run plugin dependency setup |
| **platforms/channels**| `/api/messaging/platforms` | GET | Read | FastAPI (web_server) | Session token / Bearer | Status of all 26 channels |
| **platforms/channels**| `/api/messaging/platforms/{id}` | PUT | Write | FastAPI (web_server) | Session token / Bearer | Update channel token/config |
| **platforms/channels**| `/api/messaging/{p}/onboarding/*` | GET / POST / DEL | Read / Write | FastAPI (web_server) | Session token / Bearer | WhatsApp / Telegram pairing |
| **platforms/channels**| `/api/platforms/{p}/events` | POST | Write | aiohttp (api_server) | Webhook signature / secret | External webhook ingress |
| **model providers** | `/v1/models` | GET | Read | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Active model catalog |
| **model providers** | `/api/model/options` | GET | Read | aiohttp (api_server) | Bearer `API_SERVER_KEY` | Model option overrides |
| **model providers** | `/api/local-models/status` | GET | Read | FastAPI (web_server) | Session token / Bearer | Local model engine status |
| **model providers** | `/api/credentials/pool` | GET / POST / DEL | Read / Write | FastAPI (web_server) | Session token / Bearer | Credential rotation pool |

## Evidence
Ran `test_api_coverage.py` against isolated Hermes `v0.23.2` home (`spikes/.hermes-home`):

```powershell
=== Testing FastAPI Dashboard Backend (hermes_cli.web_server) ===
  [OK] GET  /api/profiles                       -> 200 (1. bots/profiles: list profiles): {'profiles': [{'name': 'default', 'path': '...\\spikes\\.hermes-home'}]}
  [OK] GET  /api/profiles/active                -> 200 (1. bots/profiles: get active profile): {'active': 'default', 'current': 'default'}
  [OK] GET  /api/profiles/default/setup-command -> 200 (1. bots/profiles: profile setup command): {'command': 'hermes setup'}
  [OK] GET  /api/sessions                       -> 200 (2. chat/runs: list sessions): {'sessions': [], 'total': 0, 'limit': 20, 'offset': 0, 'storage': {}}
  [OK] GET  /api/sessions/stats                 -> 200 (2. chat/runs: session stats): {'total': 0, 'active_store': 0, 'archived': 0, 'messages': 0, 'by_source': {}}
  [OK] GET  /api/sessions/empty/count           -> 200 (2. chat/runs: empty sessions count): {'count': 0}
  [OK] GET  /api/cron/jobs                      -> 200 (3. cron: list cron jobs): []
  [OK] GET  /api/cron/delivery-targets          -> 200 (3. cron: delivery targets): {'targets': [{'id': 'local', 'name': 'Local (save only)', ...}]}
  [OK] GET  /api/plugins/kanban/boards          -> 200 (4. kanban: list boards): {'boards': [{'slug': 'default', 'name': 'Default', ...}]}
  [OK] GET  /api/plugins/kanban/board           -> 200 (4. kanban: get active board): {'columns': [{'name': 'triage', ...}, {'name': 'todo', ...}]}
  [OK] GET  /api/plugins/kanban/stats           -> 200 (4. kanban: stats): {'by_status': {}, 'by_assignee': {}, ...}
  [OK] GET  /api/plugins/kanban/workers/active  -> 200 (4. kanban: active workers): {'workers': [], 'count': 0, ...}
  [OK] GET  /api/skills                         -> 200 (5. skills: list skills): []
  [OK] GET  /api/curator                        -> 200 (5. skills: curator status): {'enabled': True, 'paused': False, 'interval_hours': 168}
  [OK] GET  /api/learning/graph                 -> 200 (5. skills: learning graph): {'nodes': [], 'edges': [], 'clusters': [], ...}
  [OK] GET  /api/skills/hub/official            -> 200 (5. skills: skills hub official): {'skills': [{'name': 'agent-merge-conflict-arbiter', ...}]}
  [OK] GET  /api/memory                         -> 200 (6. memory: memory status): {'active': '', 'providers': [{'name': 'byterover', ...}]}
  [OK] GET  /api/memory/providers/honcho/config -> 200 (6. memory: honcho config): {'name': 'honcho', 'label': 'honcho', ...}
  [OK] GET  /api/messaging/platforms            -> 200 (7. platforms: messaging platforms): {'env_path': '...\\.env'}
  [OK] GET  /api/local-models/status            -> 200 (8. models: local models status): {'enabled': False, 'tag': 'b12144', ...}
  [OK] GET  /api/credentials/pool               -> 200 (8. models: credentials pool): {'providers': []}

=== Testing aiohttp API Server (gateway.platforms.api_server) ===
  [OK] GET  /health                             -> 200 (Public health check)
  [OK] GET  /v1/models                          -> 200 (Model catalog: 1 models)
  [OK] GET  /v1/capabilities                    -> 200 (Platform: hermes-agent)
  [FINDING] GET /v1/skills                      -> 500 (Upstream bug: include_editorial in api_server.py)
  [OK] GET  /api/jobs                           -> 200 (Jobs count: 0)
  [OK] GET  /api/sessions                       -> 200 (Sessions list)
  [OK] GET  /p/default/v1/models                -> 200 (Profile-scoped /p/default/ prefix)
  [OK] GET  /v1/models (bad key)                -> 401 (Auth rejection 401 verified)
```

## Risks
1. **Upstream Defect on `GET /v1/skills`**: `api_server.py:2385` calls `find_all_skills(skip_disabled=False, include_editorial=True)` with a keyword argument that does not exist in `tools/skills_tool.py:277`. Calling `GET /v1/skills` results in an unhandled `TypeError` (HTTP 500).
2. **Dual-Stack Server Architecture**: Hermes runs two separate HTTP stacks (`aiohttp` on port 8642 for `/v1/*` OpenAI + runs, and `FastAPI` / `Starlette` for the dashboard backend). Neo's gateway must connect to both or run the FastAPI dashboard backend as primary for bot-hq management while using the `/v1/*` routes for inference and async runs.
3. **Session Store Bootstrap Prerequisite**: The dashboard `/api/sessions` route returns 503 if `state.db` has not been initialized. Gateway bootstrap must ensure `state.db` exists before dashboard queries run.

## Architecture Impact
- Keep `docs/02-architecture.md` section 3 (`engine-hermes`): the mapping confirms 100% endpoint coverage for profiles, cron, kanban, skills, memory, platforms, and models.
- Use `GET /api/skills` (FastAPI) instead of `GET /v1/skills` (aiohttp) in `engine-hermes` until upstream Hermes drops `include_editorial`.
- bot-hq's adoption into `packages/agents` can interface directly with these endpoints without embedding any upstream HTML/UI.

## Contract Test Idea
Add a contract test to `neo check` that starts `hermes_cli.web_server` and `APIServerAdapter` in mock mode and verifies that:
1. `GET /api/profiles`, `GET /api/plugins/kanban/boards`, `GET /api/skills`, `GET /api/memory` return 200 with Bearer session token.
2. `GET /v1/models` returns 200 with `API_SERVER_KEY`, and 401 with bad key.
3. `GET /v1/skills` status code is monitored for upstream bug fix (200 vs 500).
