"""Hermes Agent Contract Test Suite for Engine Bump Verification.

Executable contract suite for `neo check:engines`.
Verifies:
1. Fresh temp HERMES_HOME isolation & upstream session store bootstrap.
2. Dashboard auth (valid session token -> 200 on /api/profiles and /api/sessions, invalid -> 401).
3. Bot profile lifecycle (create, switch, delete).
4. Cron job lifecycle (create, trigger run, delete).
5. Kanban lifecycle (create task, patch status).
6. aiohttp /v1/runs streaming SSE and tool approval denial.
7. /v1/runs/{id}/stop reaching terminal state (cancelled/interrupted).
8. External memory provider plugin real turn (prefetch, prompt injection, turn write).
9. External computer_use backend plugin real turn (start, click, capture).

Outputs one PASS/FAIL line per check and returns exit code 0 if all pass.
"""

import asyncio
import json
import logging
import os
os.environ["HERMES_EXEC_ASK"] = "1"
os.environ["API_SERVER_ENABLED"] = "true"
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
import shutil
import socketserver
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# -----------------------------------------------------------------------------
# 1. Resolve Upstream Hermes from upstream.lock.json & NMH_UPSTREAM_CACHE
# -----------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = REPO_ROOT / "upstream.lock.json"
if not LOCK_PATH.exists():
    raise FileNotFoundError(f"Critical: upstream.lock.json not found at {LOCK_PATH}")

with open(LOCK_PATH, "r", encoding="utf-8") as f:
    LOCK_DATA = json.load(f)

HERMES_PIN = LOCK_DATA["pins"]["hermes-agent"]["ref"]
DEFAULT_CACHE = r"C:\Users\Neo\Desktop\nmh-upstream-cache"
CACHE_DIR = Path(os.environ.get("NMH_UPSTREAM_CACHE", DEFAULT_CACHE))
HERMES_DIR = CACHE_DIR / f"hermes-agent@{HERMES_PIN}"

if not HERMES_DIR.exists():
    raise RuntimeError(f"Hermes upstream directory not found at: {HERMES_DIR}")

if str(HERMES_DIR) not in sys.path:
    sys.path.insert(0, str(HERMES_DIR))

# Import upstream components
from aiohttp.test_utils import TestClient as AioTestClient, TestServer as AioTestServer
from fastapi.testclient import TestClient as FastAPITestClient
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from hermes_state import SessionDB
from hermes_cli import web_server

MODEL_PORT = 18898
L1_PORT = 18899
API_KEY_SECRET = "hermes-contract-test-secret-key-32chars!!"

# -----------------------------------------------------------------------------
# 2. Fake OpenAI Streaming Server (port 18898)
# -----------------------------------------------------------------------------
RECORDED_REQUESTS: List[dict] = []

class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class FakeOpenAIHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Quiet logging

    def do_GET(self):
        if self.path.endswith("/models"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"object": "list", "data": [{"id": "fake-model", "object": "model"}]}).encode("utf-8"))
        elif self.path.endswith("/requests"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"requests": RECORDED_REQUESTS}).encode("utf-8"))
        else:
            self.send_response(200)
            self.end_headers()

    def do_POST(self):
        if "/chat/completions" in self.path:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            RECORDED_REQUESTS.append(body)

            messages = body.get("messages", [])
            stream = body.get("stream", False)
            has_tool_result = any(m.get("role") == "tool" for m in messages)

            user_text = ""
            for m in reversed(messages):
                if m.get("role") == "user":
                    c = m.get("content", "")
                    user_text = c if isinstance(c, str) else str(c)
                    break

            trigger_approval = "trigger_approval" in user_text and not has_tool_result
            trigger_cu = "trigger_computer_use" in user_text and not has_tool_result

            self.send_response(200)
            if stream:
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()

                def send_chunk(delta, finish_reason=None):
                    chunk = {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": "fake-model",
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
                    }
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                    self.wfile.flush()

                send_chunk({"role": "assistant", "content": ""})
                if trigger_approval:
                    send_chunk({
                        "content": "Initiating terminal command requiring approval...",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_rm_danger",
                            "type": "function",
                            "function": {"name": "terminal", "arguments": json.dumps({"command": "rm -rf /tmp/danger_zone"})},
                        }],
                    })
                    send_chunk({}, finish_reason="tool_calls")
                elif trigger_cu:
                    send_chunk({
                        "content": "Initiating desktop click...",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_cu_click",
                            "type": "function",
                            "function": {"name": "computer_use", "arguments": json.dumps({"action": "click", "coordinate": [100, 200], "capture_after": True})},
                        }],
                    })
                    send_chunk({}, finish_reason="tool_calls")
                else:
                    msg = "Turn completed following tool execution." if has_tool_result else "Standard simulated turn reply."
                    send_chunk({"content": msg})
                    send_chunk({}, finish_reason="stop")

                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if trigger_approval:
                    resp = {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion",
                        "choices": [{
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "Calling tool...",
                                "tool_calls": [{
                                    "id": "call_rm_danger",
                                    "type": "function",
                                    "function": {"name": "terminal", "arguments": json.dumps({"command": "rm -rf /tmp/danger_zone"})},
                                }],
                            },
                            "finish_reason": "tool_calls",
                        }],
                    }
                elif trigger_cu:
                    resp = {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion",
                        "choices": [{
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "Calling computer_use click...",
                                "tool_calls": [{
                                    "id": "call_cu_click",
                                    "type": "function",
                                    "function": {"name": "computer_use", "arguments": json.dumps({"action": "click", "coordinate": [100, 200], "capture_after": True})},
                                }],
                            },
                            "finish_reason": "tool_calls",
                        }],
                    }
                else:
                    msg = "Turn completed following tool execution." if has_tool_result else "Standard simulated turn reply."
                    resp = {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion",
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": msg}, "finish_reason": "stop"}],
                    }
                self.wfile.write(json.dumps(resp).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

# -----------------------------------------------------------------------------
# 3. Fake L1 Memory HTTP Server (port 18899)
# -----------------------------------------------------------------------------
RECORDED_L1_WRITES: List[dict] = []
RECORDED_L1_RECALLS: List[str] = []

class FakeL1Server(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/context":
            params = urllib.parse.parse_qs(parsed.query)
            q = params.get("q", [""])[0]
            RECORDED_L1_RECALLS.append(q)
            resp = {"context": f"NEO-L1-RECALL: Found knowledge for query '{q}'. User prefers modular TypeScript extensions."}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp).encode("utf-8"))
        elif parsed.path == "/writes":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"writes": RECORDED_L1_WRITES, "recalls": RECORDED_L1_RECALLS}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/write":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            data = json.loads(body)
            RECORDED_L1_WRITES.append(data)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

# -----------------------------------------------------------------------------
# 4. Main Contract Suite Runner
# -----------------------------------------------------------------------------
async def run_suite() -> bool:
    print(f"============================================================")
    print(f" Hermes Engine Contract Suite (Pinned Ref: {HERMES_PIN})")
    print(f" Upstream Cache: {HERMES_DIR}")
    print(f"============================================================")

    results: Dict[str, Tuple[bool, str]] = {}
    temp_home = tempfile.mkdtemp(prefix="hermes_contract_")
    os.environ["HERMES_HOME"] = temp_home
    os.environ["API_SERVER_KEY"] = API_KEY_SECRET
    os.environ["HERMES_EXEC_ASK"] = "1"
    os.environ["API_SERVER_ENABLED"] = "true" 

    # Start background servers
    RECORDED_REQUESTS.clear()
    model_http_server = ThreadingHTTPServer(("127.0.0.1", MODEL_PORT), FakeOpenAIHandler)
    model_thread = threading.Thread(target=model_http_server.serve_forever, daemon=True)
    model_thread.start()

    RECORDED_L1_WRITES.clear()
    RECORDED_L1_RECALLS.clear()
    l1_http_server = HTTPServer(("127.0.0.1", L1_PORT), FakeL1Server)
    l1_thread = threading.Thread(target=l1_http_server.serve_forever, daemon=True)
    l1_thread.start()

    aio_adapter = None
    try:
        # Step 1: Upstream session store bootstrap
        session_db = SessionDB()
        session_db.close()

        # Step 2: Write config.yaml
        config_path = Path(temp_home) / "config.yaml"
        config_path.write_text(
            "model:\n"
            "  provider: custom\n"
            "  default: fake-model\n"
            "providers:\n"
            "  custom:\n"
            "    base_url: http://127.0.0.1:18898/v1\n"
            "    api_key: dummy-key\n",
            encoding="utf-8"
        )

        # ---------------------------------------------------------------------
        # CHECK 1: Dashboard Auth (Good token -> 200, Bad token -> 401)
        # ---------------------------------------------------------------------
        try:
            token = web_server._SESSION_TOKEN
            fastapi_client = FastAPITestClient(web_server.app, cookies={"session": token})
            good_headers = {"X-Hermes-Session-Token": token}
            bad_headers = {"X-Hermes-Session-Token": "invalid-token"}

            r_good = fastapi_client.get("/api/profiles", headers=good_headers)
            r_sessions = fastapi_client.get("/api/sessions", headers=good_headers)
            r_bad = fastapi_client.get("/api/profiles", headers=bad_headers)

            assert r_good.status_code == 200, f"Expected 200 on valid token, got {r_good.status_code}"
            assert r_sessions.status_code == 200, f"Expected 200 on /api/sessions, got {r_sessions.status_code}"
            assert r_bad.status_code == 401, f"Expected 401 on invalid token, got {r_bad.status_code}"
            results["dashboard_auth"] = (True, "Good token authenticated (200), bad token rejected (401), session store verified initialized")
        except Exception as e:
            results["dashboard_auth"] = (False, str(e))

        # ---------------------------------------------------------------------
        # CHECK 2: Profile Lifecycle (Create, Switch, Delete)
        # ---------------------------------------------------------------------
        try:
            bot_name = f"contract_bot_{int(time.time())}"
            r_create = fastapi_client.post("/api/profiles", json={"name": bot_name}, headers=good_headers)
            assert r_create.status_code == 200, f"Failed to create profile: {r_create.text}"

            r_switch = fastapi_client.post("/api/profiles/active", json={"name": bot_name}, headers=good_headers)
            assert r_switch.status_code == 200, f"Failed to switch profile: {r_switch.text}"

            # Switch back to default before deleting
            fastapi_client.post("/api/profiles/active", json={"name": "default"}, headers=good_headers)
            r_del = fastapi_client.delete(f"/api/profiles/{bot_name}", headers=good_headers)
            assert r_del.status_code == 200, f"Failed to delete profile: {r_del.text}"
            results["profile_lifecycle"] = (True, f"Created, activated, and deleted bot profile '{bot_name}'")
        except Exception as e:
            results["profile_lifecycle"] = (False, str(e))

        # ---------------------------------------------------------------------
        # CHECK 3: Cron Lifecycle (Create, Trigger, Delete)
        # ---------------------------------------------------------------------
        try:
            r_cron = fastapi_client.post("/api/cron/jobs", json={"prompt": "echo contract", "schedule": "0 0 * * *"}, headers=good_headers)
            assert r_cron.status_code == 200, f"Create cron failed: {r_cron.text}"
            job_id = r_cron.json()["id"]

            r_trig = fastapi_client.post(f"/api/cron/jobs/{job_id}/trigger", headers=good_headers)
            assert r_trig.status_code == 200, f"Trigger cron failed: {r_trig.text}"

            r_cdel = fastapi_client.delete(f"/api/cron/jobs/{job_id}", headers=good_headers)
            assert r_cdel.status_code == 200, f"Delete cron failed: {r_cdel.text}"
            results["cron_lifecycle"] = (True, f"Created, triggered, and deleted cron job '{job_id}'")
        except Exception as e:
            results["cron_lifecycle"] = (False, str(e))

        # ---------------------------------------------------------------------
        # CHECK 4: Kanban Lifecycle (Create task, Patch status)
        # ---------------------------------------------------------------------
        try:
            r_task = fastapi_client.post("/api/plugins/kanban/tasks", json={"title": "Contract verification task", "column": "todo"}, headers=good_headers)
            assert r_task.status_code == 200, f"Create kanban task failed: {r_task.text}"
            task_id = r_task.json()["task"]["id"]

            r_patch = fastapi_client.patch(f"/api/plugins/kanban/tasks/{task_id}", json={"status": "blocked"}, headers=good_headers)
            assert r_patch.status_code == 200, f"Patch kanban task failed: {r_patch.text}"
            results["kanban_lifecycle"] = (True, f"Created task '{task_id}' and patched status to 'blocked'")
        except Exception as e:
            results["kanban_lifecycle"] = (False, str(e))

        # Connect aiohttp APIServerAdapter
        cfg = PlatformConfig(
            enabled=True,
            api_key=API_KEY_SECRET,
            extra={"port": 18889, "host": "127.0.0.1"}
        )
        aio_adapter = APIServerAdapter(cfg)
        ok = await aio_adapter.connect()
        assert ok, "APIServerAdapter connect failed"

        aio_headers = {
            "Authorization": f"Bearer {API_KEY_SECRET}",
            "Content-Type": "application/json",
        }

        async with AioTestClient(AioTestServer(aio_adapter._app)) as client:
            # -----------------------------------------------------------------
            # CHECK 5: /v1/runs SSE Streaming & Tool Approval Denial
            # -----------------------------------------------------------------
            try:
                post_run = await client.post("/v1/runs", json={"input": "trigger_approval clean temp directory"}, headers=aio_headers)
                assert post_run.status == 202, f"POST /v1/runs failed: {post_run.status} {await post_run.text()}"
                run_id = (await post_run.json())["run_id"]

                sse_res = await client.get(f"/v1/runs/{run_id}/events", headers=aio_headers)
                assert sse_res.status == 200

                approval_handled = False
                completed_received = False
                while True:
                    line = await sse_res.content.readline()
                    if not line:
                        break
                    line_str = line.decode("utf-8").strip()
                    if not line_str:
                        continue
                    if line_str.startswith("data: "):
                        try:
                            event_data = json.loads(line_str[6:].strip())
                        except Exception:
                            continue
                        ev_name = event_data.get("event")
                        if ev_name == "approval.request" and not approval_handled:
                            approval_handled = True
                            app_res = await client.post(f"/v1/runs/{run_id}/approval", json={"choice": "deny"}, headers=aio_headers)
                            assert app_res.status == 200
                        elif ev_name == "run.completed":
                            completed_received = True
                    elif line_str == ": stream closed":
                        break

                assert approval_handled, "Did not receive approval.request SSE event"
                assert completed_received, "Did not receive run.completed SSE event"

                status_res = await client.get(f"/v1/runs/{run_id}", headers=aio_headers)
                final_st = (await status_res.json()).get("status")
                assert final_st == "completed", f"Expected final status completed, got {final_st}"
                results["runs_sse_approval_deny"] = (True, f"Run {run_id} emitted approval.request, denied cleanly, completed turn")
            except Exception as e:
                results["runs_sse_approval_deny"] = (False, str(e))

            # -----------------------------------------------------------------
            # CHECK 6: /v1/runs/{id}/stop Reaching Terminal State
            # -----------------------------------------------------------------
            try:
                post_stop_run = await client.post("/v1/runs", json={"input": "long task to be stopped"}, headers=aio_headers)
                assert post_stop_run.status == 202
                stop_run_id = (await post_stop_run.json())["run_id"]

                stop_req = await client.post(f"/v1/runs/{stop_run_id}/stop", json={}, headers=aio_headers)
                assert stop_req.status == 200

                # Poll until terminal status reached
                poll_deadline = time.time() + 8.0
                terminal_status = None
                while time.time() < poll_deadline:
                    st_resp = await client.get(f"/v1/runs/{stop_run_id}", headers=aio_headers)
                    current_st = (await st_resp.json()).get("status")
                    if current_st in {"cancelled", "interrupted", "completed", "failed"}:
                        terminal_status = current_st
                        break
                    await asyncio.sleep(0.1)

                assert terminal_status in {"cancelled", "interrupted"}, f"Expected cancelled/interrupted, got {terminal_status}"
                results["run_stop_terminal_state"] = (True, f"Run {stop_run_id} stopped and reached terminal status: '{terminal_status}'")
            except Exception as e:
                results["run_stop_terminal_state"] = (False, str(e))

            # -----------------------------------------------------------------
            # CHECK 7: Memory Provider Plugin Real Turn (Spike f)
            # -----------------------------------------------------------------
            try:
                # Install neo_l1 plugin from local plugins folder
                plugins_dir = Path(__file__).parent / "plugins" / "neo_l1"
                if not plugins_dir.exists():
                    plugins_dir = REPO_ROOT / "spikes" / "P0-3f-hermes-memory" / "neo_l1_plugin"
                dest_l1 = Path(temp_home) / "plugins" / "neo_l1"
                shutil.copytree(plugins_dir, dest_l1)

                # Update config with memory.provider: neo_l1
                config_path.write_text(
                    "model:\n"
                    "  provider: custom\n"
                    "  default: fake-model\n"
                    "providers:\n"
                    "  custom:\n"
                    "    base_url: http://127.0.0.1:18898/v1\n"
                    "    api_key: dummy-key\n"
                    "memory:\n"
                    "  provider: neo_l1\n",
                    encoding="utf-8"
                )

                prompt = "What are the preferences for Neo architecture?"
                post_mem = await client.post("/v1/runs", json={"input": prompt}, headers=aio_headers)
                assert post_mem.status == 202
                mem_run_id = (await post_mem.json())["run_id"]

                # Wait for completion
                sse_mem = await client.get(f"/v1/runs/{mem_run_id}/events", headers=aio_headers)
                while True:
                    l = await sse_mem.content.readline()
                    if not l or l.decode("utf-8").strip() in {"event: run.completed", ": stream closed"}:
                        break

                await asyncio.sleep(0.4)

                # Verify (a) prefetch call
                assert any(prompt in r for r in RECORDED_L1_RECALLS), f"Fake L1 did not receive prefetch for '{prompt}'"

                # Verify (b) injected context in model request
                injected_found = False
                for req in RECORDED_REQUESTS:
                    for m in req.get("messages", []):
                        if "NEO-L1-RECALL" in str(m.get("content", "")):
                            injected_found = True
                            break
                assert injected_found, "Recalled context 'NEO-L1-RECALL' did not reach model request prompt"

                # Verify (c) turn write landed
                turn_writes = [w for w in RECORDED_L1_WRITES if w.get("type") == "turn" and prompt in w.get("user", "")]
                assert len(turn_writes) > 0, "Turn write was not recorded on Fake L1 Server"

                results["memory_provider_turn"] = (True, "neo_l1 plugin served prefetch, injected context into prompt, and recorded turn write")
            except Exception as e:
                results["memory_provider_turn"] = (False, str(e))

            # -----------------------------------------------------------------
            # CHECK 8: Computer Use Backend Plugin Real Turn (Spike c)
            # -----------------------------------------------------------------
            try:
                # Install neo_vnc plugin
                cu_src = Path(__file__).parent / "plugins" / "neo_vnc"
                if not cu_src.exists():
                    cu_src = REPO_ROOT / "spikes" / "P0-3c-hermes-screen" / "neo_vnc_plugin"
                dest_vnc = Path(temp_home) / "plugins" / "neo_vnc"
                shutil.copytree(cu_src, dest_vnc)

                # Update config with computer_use.backend: neo_vnc
                config_path.write_text(
                    "model:\n"
                    "  provider: custom\n"
                    "  default: fake-model\n"
                    "providers:\n"
                    "  custom:\n"
                    "    base_url: http://127.0.0.1:18898/v1\n"
                    "    api_key: dummy-key\n"
                    "computer_use:\n"
                    "  backend: neo_vnc\n",
                    encoding="utf-8"
                )

                os.environ["HERMES_INTERACTIVE"] = "1"
                from tools.computer_use import tool as cu_tool
                cu_tool.set_approval_callback(lambda command, description, **kw: "once")

                try:
                    from run_agent import AIAgent
                    agent = AIAgent(
                        model="fake-model",
                        base_url="http://127.0.0.1:18898/v1",
                        api_key="dummy-key",
                        max_iterations=2,
                    )
                    agent_res = agent.run_conversation("trigger_computer_use click the Submit button")
                    assert agent_res.get("completed") is True
                finally:
                    try:
                        agent.close()
                    except Exception:
                        pass
                    cu_tool.set_approval_callback(None)
                    os.environ.pop("HERMES_INTERACTIVE", None)

                neo_vnc_mod = sys.modules.get("_hermes_user_computer_use.neo_vnc")
                assert neo_vnc_mod is not None, "neo_vnc plugin module was not loaded"
                calls = neo_vnc_mod.CALLS
                has_start = any(a == "start" for a, _ in calls)
                has_click = any(a == "click" for a, _ in calls)
                has_capture = any(a == "capture" for a, _ in calls)
                assert has_start and has_click and has_capture, f"Missing actions in neo_vnc calls: {calls}"

                results["computer_use_plugin_turn"] = (True, "neo_vnc plugin loaded and executed start, click, and capture in real agent turn")
            except Exception as e:
                results["computer_use_plugin_turn"] = (False, str(e))

    finally:
        if aio_adapter is not None:
            await aio_adapter.disconnect()
        model_http_server.shutdown()
        model_http_server.server_close()
        l1_http_server.shutdown()
        l1_http_server.server_close()

        # 1. Close SessionDB registry handles & clear caches
        try:
            from hermes_state_registry import close_all, close_all_under
            close_all_under(temp_home)
            close_all()
        except Exception:
            pass

        try:
            from hermes_cli import goals
            goals._DB_CACHE.clear()
        except Exception:
            pass

        # 2. Release Hermes profile log handlers & tear down async logging queue
        try:
            import hermes_logging
            hermes_logging.release_profile_log_handlers(temp_home)
            hermes_logging._reset_queued_handlers()
        except Exception:
            pass

        # 3. Shutdown standard logging and close all open handlers across all loggers
        logging.shutdown()
        for logger in [logging.root] + list(logging.Logger.manager.loggerDict.values()):
            if hasattr(logger, "handlers"):
                for h in list(logger.handlers):
                    try:
                        h.flush()
                        h.close()
                    except Exception:
                        pass
                    try:
                        logger.removeHandler(h)
                    except Exception:
                        pass

        import gc
        gc.collect()

        # 4. Retry rmtree with backoff
        cleanup_passed = False
        for attempt in range(10):
            try:
                if os.path.exists(temp_home):
                    shutil.rmtree(temp_home)
                cleanup_passed = True
                break
            except Exception as e:
                print(f"Cleanup attempt {attempt} failed: {e}")
                time.sleep(0.3)
                gc.collect()

        if not cleanup_passed:
            cleanup_passed = not os.path.exists(temp_home)

        print(f"CLEANUP {'PASS' if cleanup_passed else 'FAIL'}: {temp_home}")

    # Print Report
    print("\n--- Hermes Contract Test Results ---")
    all_passed = True
    for check_name, (passed, detail) in results.items():
        status_str = "PASS" if passed else "FAIL"
        print(f"[{status_str}] {check_name}: {detail}")
        if not passed:
            all_passed = False

    print(f"\nFinal Verdict: {'ALL CHECKS PASSED' if all_passed else 'SOME CHECKS FAILED'}")
    return all_passed

if __name__ == "__main__":
    success = asyncio.run(run_suite())
    sys.exit(0 if success else 1)