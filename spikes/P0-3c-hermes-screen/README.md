# P0-3c Hermes External Screen and Computer Use Seam
Verdict: WORKS
Question: How do Bot Screen and `computer_use` (cua-driver) pick their display and backend? Can an external computer (a VNC host, Orgo, boat.dev) be plugged in through a plugin or config without editing Hermes?
Pinned ref: hermes-agent@v0.23.2 (commit `ae2a81ccc00e9b7c06301523e5bb09608397149c`)
Seam:
- `tools/computer_use/backend.py`: `ComputerUseProvider` and `ComputerUseBackend` ABCs; `ctx.register_computer_use_provider()`
- `tools/computer_use/tool.py`: `computer_use.backend` configuration dispatch in `handle_computer_use`
- `tests/tools/test_computer_use_backend_plugins.py`: Reference test proving external provider plugins are loaded and executed
- `tools/bot_desktop/runtime.py` and `tools/bot_desktop/placement.py`: Bot Screen display allocation (`:20`–`:89`), `rfb.sock`, sandbox/stream placement
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
    - Bridges WebSocket binary frames directly to `rfb.sock` (or an SSH/docker stdio stream via `_open_rfb`).
    - Filters client input packets through `RfbClientFilter` to enforce `lease.py` (only the human or agent holding the lease can send input; spectators are read-only).

### 3. Plugging in External Computers (VNC host, Orgo, boat.dev) Without Editing Hermes

External computers can be integrated cleanly without touching Hermes in two complementary ways:

#### A. Pluggable `computer_use` Provider Plugin (Zero Hermes Edits)
Create a plugin under `$HERMES_HOME/plugins/<provider_name>/` (e.g. `plugins/orgo`, `plugins/boat`, `plugins/vnc_computer`):
- `plugin.yaml`:
  ```yaml
  name: orgo
  version: 1.0.0
  description: "Orgo cloud sandbox computer use driver"
  config_keys:
    - computer_use.orgo
  ```
- `__init__.py`:
  ```python
  from tools.computer_use.backend import ComputerUseBackend, ComputerUseProvider, ActionResult, CaptureResult

  class OrgoBackend(ComputerUseBackend):
      # Dispatches click, type_text, scroll, capture over Orgo / boat.dev / VNC API
      ...

  class OrgoProvider(ComputerUseProvider):
      name = "orgo"
      def create_backend(self, *, permission_mode):
          return OrgoBackend(permission_mode)

  def register(ctx):
      ctx.register_computer_use_provider(OrgoProvider())
  ```
- Activate in `config.yaml`:
  ```yaml
  computer_use:
    backend: orgo
  ```
Verified by `tests/tools/test_computer_use_backend_plugins.py`: Hermes loads the plugin, registers the provider, and delegates all agent actions to it.

#### B. External Screen RFB Socket Bridge (Zero Hermes Edits)
For interactive streaming in the UI:
- Bot Screen's viewer (`display_ws` in `hermes_cli/web_routers/display.py`) connects directly to `<HERMES_HOME>/bot-desktop/rfb.sock`.
- To stream an external VNC host (e.g. cloud VM, Docker container, or QEMU guest), Neo's gateway can bridge the external VNC TCP port to `rfb.sock` (e.g. via `socat` or an async proxy socket) or set `_open_rfb` relay.
- The noVNC canvas in the Desktop / Web App interacts with the external computer screen transparently.

#### C. Remote MCP via `cua-driver` Daemon
- `cua-driver.exe` supports `--socket <path>` and `cua-driver serve` (daemon mode).
- A remote VM can run `cua-driver serve` and expose its MCP pipe/socket to Hermes over SSH or reverse tunnel, using Hermes's built-in `cua` backend without changes.

## Evidence
1. **Upstream test verification**:
   Read `tests/tools/test_computer_use_backend_plugins.py`, which validates that custom provider plugins in `$HERMES_HOME/plugins/<name>` register via `ctx.register_computer_use_provider()`, become selectable via `computer_use.backend: <name>`, and receive all `click`, `drag`, `type_text`, `scroll` tool calls.
2. **Code inspection**:
   - `tools/computer_use/backend.py:80-160`: `ComputerUseBackend` and `ComputerUseProvider` ABCs.
   - `tools/bot_desktop/placement.py:40-100`: Placement resolution logic.
   - `hermes_cli/web_routers/display.py:85-140`: RFB stream WebSocket bridge.
3. **cua-driver inspection**:
   Ran `C:\Users\Neo\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe --help`, confirming `--socket`, `--permission-mode`, `autostart`, and MCP daemon flags.

## Risks
1. **Linux-Only Virtual Displays for Bot Screen**: Bot Desktop's TigerVNC + Xfce launcher is explicitly restricted to Linux (`sys.platform.startswith("linux")`). On Windows and macOS hosts, `hermes computer-use screen` is disabled by design.
   - *Neo Strategy*: Neo's `neo.computers` abstraction should run virtual containerized desktops (Docker / microVMs) or connect to remote VNC/WebRTC hosts so that Windows/macOS users get bot screens without requiring host-level X11.
2. **Coordinate & Scaling Discrepancies**: Different computer backends (VNC, Orgo, boat.dev) handle HiDPI scaling, SoM (Set-of-Mark) overlay annotations, and logical-to-physical coordinate mappings differently. Neo's provider layer must normalize coordinate frames.
3. **Lease Synchronization**: When humans take over a screen, Hermes writes `<HERMES_HOME>/bot-desktop/lease.json`. Custom computer-use plugins must check this lease or respect `ActionResult(ok=False, code="control_taken")` to avoid conflicting with active human input.

## Architecture Impact
- Fully supports `docs/02-architecture.md` Section 5 ("Computers"): confirms that `computer-hermes-screen`, `computer-local`, `computer-docker`, `computer-vnc`, `computer-orgo`, and `computer-boat` can all be implemented as clean, non-invasive plugins.
- Validates that no forks or core patches of Hermes are required for multi-computer support.

## Contract Test Idea
A contract test in `neo check` verifying that:
1. `from tools.computer_use.backend import ComputerUseBackend, ComputerUseProvider` imports cleanly and ABC method signatures match expected arguments (`capture`, `click`, `drag`, `scroll`, `type_text`, `key`, `list_apps`, `focus_app`, `set_value`).
2. `from tools.bot_desktop.runtime import desktop_env` retains standard keys (`DISPLAY`, `XAUTHORITY`).
