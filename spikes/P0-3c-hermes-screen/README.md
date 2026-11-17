# P0-3c Hermes External Screen and Computer Use Seam
Verdict: WORKS
Question: How do Bot Screen and `computer_use` (cua-driver) pick their display and backend? Can an external computer (a VNC host, Orgo, boat.dev) be plugged in through a plugin or config without editing Hermes?
Pinned ref: hermes-agent@v0.23.2 (commit `ae2a81ccc00e9b7c06301523e5bb09608397149c`)
Seam:
- `tools/computer_use/backend.py`: `ComputerUseProvider` and `ComputerUseBackend` ABCs; `ctx.register_computer_use_provider()`
- `plugins/computer_use/__init__.py`: Dynamic discovery of external plugins at `$HERMES_HOME/plugins/<name>/`
- `tools/computer_use/tool.py`: `computer_use.backend` configuration dispatch in `handle_computer_use`
- `tests/tools/test_computer_use_backend_plugins.py`: Upstream pytest suite verifying external provider plugins
- `tools/bot_desktop/runtime.py` and `tools/bot_desktop/placement.py`: Bot Screen display allocation (`:20`-`:89`), `rfb.sock`, sandbox/stream placement
- `tools/bot_desktop/lease.py` & `tools/bot_desktop/rfb_filter.py`: Human takeover and agent lease arbitration
- `hermes_cli/web_routers/display.py`: `/api/display/ws` WebSocket-to-RFB bridge
- `cua-driver` CLI: `C:\Users\Neo\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe`

## Architecture Analysis

### 1. How `computer_use` Picks Its Display / Backend
Hermes's `computer_use` tool has a pluggable provider architecture:
- Config: `computer_use.backend` in `config.yaml` (default: `"cua"`).
- Discovery: Hermes scans for `ComputerUseProvider` plugins in `plugins/computer_use/<name>/` and user plugin directories `$HERMES_HOME/plugins/<name>/`. Only the selected backend is imported and instantiated.
- Default `"cua"` backend (`tools/computer_use/cua_backend.py`):
  - On **Linux**: Checks if Bot Desktop is active via `tools.bot_desktop.runtime.desktop_env()`. If running, it injects `DISPLAY=:<N>`, `XAUTHORITY=...`, and `DBUS_SESSION_BUS_ADDRESS=...` so `cua-driver` operates on that bot's private X11 virtual display.
  - On **Windows / macOS**: Connects to the host display directly (Windows UI Automation via `cua-driver-uia.exe`; macOS via Quartz/SkyLight/AX APIs).
- Custom backends: Subclass `ComputerUseProvider` and implement `ComputerUseBackend` (`start`, `stop`, `is_available`, `capture`, `click`, `drag`, `scroll`, `type_text`, `key`, `list_apps`, `focus_app`, `set_value`, `wait`).

### 2. How Bot Screen Picks Its Display
- Host constraint: Virtual Xfce screens are supported on **Linux hosts only** (`runtime.is_supported_host()`). On Windows/macOS hosts, Hermes expects a real desktop.
- Placement (`tools/bot_desktop/placement.py`):
  - If `terminal.backend` is `local`: runs directly on gateway host.
  - If `terminal.backend` is `docker` or `ssh` (or a terminal plugin with `supports_streams: true`): runs inside that sandbox/container.
- Runtime (`tools/bot_desktop/runtime.py`):
  - Scans for an available display between `:20` and `:89`.
  - Spawns TigerVNC `Xvnc` + Xfce (`launcher.sh`) listening on a private Unix socket `<HERMES_HOME>/bot-desktop/rfb.sock` (0600 permissions).
  - Web viewer (`hermes_cli/web_routers/display.py`):
    - Serves `/api/display/ws?display_ticket=...`.
    - Bridges WebSocket binary frames directly to `rfb.sock` (or an SSH/docker stdio stream via private `_open_rfb`).
    - Filters client input packets through `RfbClientFilter` to enforce `lease.py` (only the human or agent holding the lease can send input; spectators are read-only).

### 3. Plugging in External Computers (VNC host, Orgo, boat.dev) Without Editing Hermes

External computers can be integrated cleanly without touching Hermes in the following ways:

#### Option A. Pluggable `computer_use` Provider Plugin (Zero Hermes Edits - WORKS & Proven)
Create a plugin under `$HERMES_HOME/plugins/<provider_name>/` (e.g. `plugins/neo_vnc`, `plugins/orgo`, `plugins/boat`):
- `plugin.yaml`:
  ```yaml
  name: neo_vnc
  version: 1.0.0
  description: "Neo VNC computer use backend plugin"
  config_keys:
    - computer_use.neo_vnc
  ```
- `__init__.py`:
  ```python
  from tools.computer_use.backend import ComputerUseBackend, ComputerUseProvider, ActionResult, CaptureResult

  class NeoVncBackend(ComputerUseBackend):
      def capture(self, mode="som", **kw): ...
      def click(self, **kw): ...
      # Dispatches click, type_text, scroll, capture over VNC / Orgo / boat.dev API

  class NeoVncProvider(ComputerUseProvider):
      name = "neo_vnc"
      def create_backend(self, *, permission_mode):
          return NeoVncBackend(permission_mode)

  def register(ctx):
      ctx.register_computer_use_provider(NeoVncProvider())
  ```
- Activate in `config.yaml`:
  ```yaml
  computer_use:
    backend: neo_vnc
  ```
Verified both by upstream unit tests (`test_computer_use_backend_plugins.py`) and by real runtime agent turn execution (`test_computer_use_plugin.py`).

#### Option B. Neo-Served Desktop Viewer (Zero Hermes Edits - Recommended Architectural Design)
Neo serves its own viewer from the `ComputerProvider` stream, with no dependence on Hermes's private `rfb.sock` or `_open_rfb`.
- The external computer (remote VNC, Docker container, cloud VM) exposes an RFB/WebRTC stream directly to Neo's UI.
- Neo handles the viewer UI and lease arbitration directly, bypassing the Linux-only Bot Desktop host constraints completely.
- `_open_rfb` in Hermes is a private internal function; relying on or modifying it would require patching Hermes and is rejected.

#### Option C. Remote `cua-driver` over SSH (Unproven Idea)
- Theory: Running `cua-driver serve` on a remote machine and tunnelling its stdio / socket over SSH.
- Status: **Unproven idea**. While `cua-driver` has CLI flags for socket binding, tunneling raw MCP over SSH with per-turn lease tracking without a custom plugin is unverified and unnecessary given Option A is fully supported.

## Evidence

### 1. Upstream Pytest Test Execution
Ran `tests/tools/test_computer_use_backend_plugins.py` against pinned upstream source `hermes-agent@v0.23.2`:

```powershell
C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.venv\Scripts\pytest.exe 'C:\Users\Neo\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2\tests\tools\test_computer_use_backend_plugins.py' -v -o 'pythonpath=C:\Users\Neo\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2'
```

Output:
```
============================= test session starts =============================
platform win32 -- Python 3.11.16, pytest-9.2.0, pluggy-1.7.0 -- C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.venv\Scripts\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\Neo\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2
configfile: pyproject.toml
plugins: anyio-4.16.0, asyncio-1.5.0
asyncio: mode=Mode.STRICT, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
collecting ... collected 5 items

..\..\..\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2\tests\tools\test_computer_use_backend_plugins.py::test_selected_plugin_receives_tool_calls_and_unselected_stays_dormant PASSED [ 20%]
..\..\..\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2\tests\tools\test_computer_use_backend_plugins.py::test_unknown_backend_errors_naming_configured_and_available PASSED [ 40%]
..\..\..\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2\tests\tools\test_computer_use_backend_plugins.py::test_builtin_cua_is_default_and_plugin_never_self_activates[None] PASSED [ 60%]
..\..\..\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2\tests\tools\test_computer_use_backend_plugins.py::test_builtin_cua_is_default_and_plugin_never_self_activates[cua] PASSED [ 80%]
..\..\..\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2\tests\tools\test_computer_use_backend_plugins.py::test_each_profile_gets_its_own_configured_backend PASSED [100%]

============================== 5 passed in 2.98s ==============================
```

### 2. Runtime Execution Proof with `neo_vnc` Plugin in Real Agent Turn
Ran `test_computer_use_plugin.py` with `neo_vnc` plugin installed in `$HERMES_HOME/plugins/neo_vnc`, `computer_use.backend: neo_vnc` in `config.yaml`, and `fake_model_server.py` emitting `computer_use` `click` with `capture_after: True`:

```powershell
C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.venv\Scripts\python.exe C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\P0-3c-hermes-screen\test_computer_use_plugin.py
```

Output:
```
=== Testing Spike P0-3c: neo_vnc Computer Use Plugin in Real Turn ===
1. Started Fake Model Server on 127.0.0.1:18898
2. Installed neo_vnc plugin into C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.hermes-home\plugins\neo_vnc (zero edits to Hermes upstream)
3. Configured computer_use.backend: neo_vnc in config.yaml
4a. Discovered computer_use providers: [('cua', 'cua-driver (built-in) — background computer use on macOS, Windows and Linux; does not steal the cursor or focus. Default when computer_use.backend is unset.'), ('neo_vnc', 'Neo VNC computer use backend plugin')]
4b. Active computer_use provider resolved: name='neo_vnc'
5. Initializing AIAgent and running turn with trigger_computer_use...
🤖 AI Agent initialized with model: fake-model
🔗 Using custom base URL: http://127.0.0.1:18898/v1
⚠️  Warning: API key appears invalid or missing
🚫 Disabled toolset 'onboarding': setup_beat
🚫 Disabled toolset 'catalog': manage_catalog
🛠️  Final tool selection (34 tools): annotate_preview, clarify, close_terminal, computer_use, cronjob_manage, delegate_task, desktop_preview, desktop_project, drive_preview, execute_code, focus_pane, gui_tour, manage_connections, memory, patch, process_manage, read_file, read_terminal, read_window_below, search_files, session_search, set_theme, show_tip, skill_manage, skill_view, skills_list, terminal, text_to_speech, todo_list, video_analyze, vision_analyze, web_extract, web_search, write_file
🔎 Tool Search (tier 1): 19 MCP/plugin tools deferred (~9529 tokens) behind tool_search/describe/call — catalog listing embedded.
🛠️  Loaded 18 tools: clarify, delegate_task, execute_code, memory, patch, read_file, search_files, skill_manage, skill_view, skills_list, terminal, tool_call, tool_describe, tool_search, vision_analyze, web_extract, web_search, write_file
   ❌ Disabled toolsets: onboarding, catalog
📊 Context limit: 256,000 tokens (compress at 75% = 192,000)
💬 Starting conversation: 'trigger_computer_use click the Submit button'

🔄 Making API call #1/2...
   📊 Request size: 2 messages, ~1,781 tokens (~7,124 chars)
   🔧 Available tools: 18
⏱️  API call completed in 0.07s
🤖 Assistant: Driving desktop with computer_use click...
🔧 Processing 1 tool call(s)...
🔧 Routed deferred tool 'computer_use' through 'tool_call'
  📞 Tool 1: computer_use(['action', 'coordinate', 'capture_after']) - {"action": "click", "coordinate": [100, 200], "capture_after": true}
  ✅ Tool 1 completed in 0.04s - {"ok": true, "action": "click", "message": "Clicked coordinate on Neo VNC desktop", "verdict": {"decision": "act"}...}

🔄 Making API call #2/2...
   📊 Request size: 4 messages, ~1,944 tokens (~7,776 chars)
   🔧 Available tools: 18
⏱️  API call completed in 0.01s
🤖 Assistant: Turn completed following tool execution.
🎉 Conversation completed after 2 OpenAI-compatible API call(s)
6. Agent turn completed. Result: True
7. Recorded calls in NeoVncBackend (3):
   - ('start', 'standard')
   - ('click', {'element': None, 'x': 100, 'y': 200, 'button': 'left', 'click_count': 1, 'modifiers': None, 'delivery_mode': None, 'bring_to_front': False})
   - ('capture', {'mode': 'som', 'app': None, 'pid': None, 'window_id': None})

[SUCCESS] Runtime proof confirmed: neo_vnc backend plugin handled click and capture during real agent turn!
```

## Risks
1. **Linux-Only Virtual Displays for Bot Screen**: Bot Desktop's TigerVNC + Xfce launcher is explicitly restricted to Linux (`sys.platform.startswith("linux")`). On Windows and macOS hosts, `hermes computer-use screen` is disabled by design.
   - *Neo Strategy*: Neo's `neo.computers` abstraction should run virtual containerized desktops (Docker / microVMs) or connect to remote VNC/WebRTC hosts so that Windows/macOS users get bot screens without requiring host-level X11.
2. **Coordinate & Scaling Discrepancies**: Different computer backends (VNC, Orgo, boat.dev) handle HiDPI scaling, SoM (Set-of-Mark) overlay annotations, and logical-to-physical coordinate mappings differently. Neo's provider layer must normalize coordinate frames.
3. **Lease Synchronization**: When humans take over a screen, Hermes writes `<HERMES_HOME>/bot-desktop/lease.json`. Custom computer-use plugins must check this lease or respect `ActionResult(ok=False, code="control_taken")` to avoid conflicting with active human input.

## Architecture Impact
- Fully supports `docs/02-architecture.md` Section 6 ("Computers"): confirms that `computer-hermes-screen`, `computer-local`, `computer-docker`, `computer-vnc`, `computer-orgo`, and `computer-boat` can all be implemented as clean, non-invasive plugins via Option A + Option B.
- Confirms zero core patches of Hermes are required for multi-computer support.

## Contract Test Idea
A contract test in `neo check` verifying that:
1. `from tools.computer_use.backend import ComputerUseBackend, ComputerUseProvider, ActionResult, CaptureResult` imports cleanly and ABC method signatures match expected arguments (`capture`, `click`, `drag`, `scroll`, `type_text`, `key`, `list_apps`, `focus_app`, `set_value`).
2. `from plugins.computer_use import get_active_provider, discover_computer_use_providers` resolves user plugin directory without errors.
