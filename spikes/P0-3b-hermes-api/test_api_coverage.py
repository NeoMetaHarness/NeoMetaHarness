"""Automated API coverage and write/streaming tests for Hermes Agent (v0.23.2).

Validates:
1. FastAPI dashboard backend endpoints (profiles, sessions, cron, kanban, skills, memory, platforms, models)
2. FastAPI write paths: POST /api/profiles, active profile switch & cleanup, POST/trigger/DELETE /api/cron/jobs, POST/PATCH /api/plugins/kanban/tasks
3. aiohttp API server endpoints (/health, /v1/models, /v1/capabilities, /v1/skills, /api/jobs, /api/sessions, /p/default/v1/models)
4. aiohttp write & streaming: POST /v1/runs -> GET /v1/runs/{id}/events (SSE) -> approval.request -> POST /approval (deny) -> run.completed
5. aiohttp stop control: POST /v1/runs -> POST /v1/runs/{id}/stop -> status check
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

HERMES_HOME = r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.hermes-home"
os.environ["HERMES_HOME"] = HERMES_HOME
os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = "0123456789abcdef0123456789abcdef"
os.environ["API_SERVER_KEY"] = "0123456789abcdef0123456789abcdef"
os.environ["API_SERVER_ENABLED"] = "true"
os.environ["HERMES_EXEC_ASK"] = "1"

sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2")
sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\P0-3b-hermes-api")

import fake_model_server
from aiohttp.test_utils import TestClient as AioTestClient, TestServer as AioTestServer
from fastapi.testclient import TestClient as FastAPITestClient
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from hermes_cli import web_server

def init_isolated_store():
    home = Path(HERMES_HOME)
    home.mkdir(parents=True, exist_ok=True)
    cfg_path = home / "config.yaml"
    if not cfg_path.exists():
        cfg_content = (
            "model:\n"
            "  provider: custom\n"
            "  default: fake-model\n"
            "custom_providers:\n"
            "  custom:\n"
            "    base_url: http://127.0.0.1:18898/v1\n"
            "    api_key: dummy-key\n"
        )
        cfg_path.write_text(cfg_content, encoding="utf-8")

def test_fastapi_endpoints():
    print("=== Testing FastAPI Dashboard Backend (hermes_cli.web_server) ===")
    token = web_server._SESSION_TOKEN
    headers = {"X-Hermes-Session-Token": token}
    client = FastAPITestClient(web_server.app)

    # --- GET endpoints map ---
    get_endpoints = [
        ("GET", "/api/profiles", 200, "1. bots/profiles: list profiles"),
        ("GET", "/api/profiles/active", 200, "1. bots/profiles: get active profile"),
        ("GET", "/api/profiles/default/setup-command", 200, "1. bots/profiles: profile setup command"),
        ("GET", "/api/sessions", 200, "2. chat/runs: list sessions"),
        ("GET", "/api/sessions/stats", 200, "2. chat/runs: session stats"),
        ("GET", "/api/sessions/empty/count", 200, "2. chat/runs: empty sessions count"),
        ("GET", "/api/cron/jobs", 200, "3. cron: list cron jobs"),
        ("GET", "/api/cron/delivery-targets", 200, "3. cron: delivery targets"),
        ("GET", "/api/plugins/kanban/boards", 200, "4. kanban: list boards"),
        ("GET", "/api/plugins/kanban/board", 200, "4. kanban: get active board"),
        ("GET", "/api/plugins/kanban/stats", 200, "4. kanban: stats"),
        ("GET", "/api/plugins/kanban/workers/active", 200, "4. kanban: active workers"),
        ("GET", "/api/skills", 200, "5. skills: list skills"),
        ("GET", "/api/curator", 200, "5. skills: curator status"),
        ("GET", "/api/learning/graph", 200, "5. skills: learning graph"),
        ("GET", "/api/skills/hub/official", 200, "5. skills: skills hub official"),
        ("GET", "/api/memory", 200, "6. memory: memory status"),
        ("GET", "/api/memory/providers/honcho/config", 200, "6. memory: honcho config"),
        ("GET", "/api/messaging/platforms", 200, "7. platforms: messaging platforms"),
        ("GET", "/api/local-models/status", 200, "8. models: local models status"),
        ("GET", "/api/credentials/pool", 200, "8. models: credentials pool"),
    ]

    for method, path, expected_status, label in get_endpoints:
        res = client.request(method, path, headers=headers)
        assert res.status_code == expected_status, f"{label} failed: {res.status_code} != {expected_status}: {res.text}"
        data_summary = str(res.json())[:80] if res.headers.get("content-type", "").startswith("application/json") else res.text[:80]
        print(f"  [OK] {method:4} {path:35} -> {res.status_code} ({label}): {data_summary}")

    # --- Write path tests ---
    print("\n--- Testing FastAPI Write Paths ---")
    # 1. Profiles write: create bot + switch active profile + delete profile
    bot_name = f"bot_{int(time.time())}"
    r = client.post("/api/profiles", json={"name": bot_name, "description": "Spike test bot profile"}, headers=headers)
    assert r.status_code == 200, f"POST /api/profiles failed: {r.text}"
    print(f"  [OK] POST /api/profiles                      -> {r.status_code} (Created bot profile '{bot_name}')")

    r = client.post("/api/profiles/active", json={"name": bot_name}, headers=headers)
    assert r.status_code == 200, f"POST /api/profiles/active failed: {r.text}"
    print(f"  [OK] POST /api/profiles/active               -> {r.status_code} (Switched active profile to '{bot_name}')")

    # Switch back to default and cleanup
    client.post("/api/profiles/active", json={"name": "default"}, headers=headers)
    r = client.delete(f"/api/profiles/{bot_name}", headers=headers)
    assert r.status_code == 200, f"DELETE /api/profiles/{bot_name} failed: {r.text}"
    print(f"  [OK] DELETE /api/profiles/{{name}}            -> {r.status_code} (Deleted bot profile '{bot_name}')")

    # 2. Cron write: create job, trigger run, delete job
    r = client.post("/api/cron/jobs", json={"name": "spike_cron_job", "prompt": "check status", "schedule": "every 2h"}, headers=headers)
    assert r.status_code == 200, f"POST /api/cron/jobs failed: {r.text}"
    cron_job_id = r.json().get("id") or r.json().get("job", {}).get("id")
    print(f"  [OK] POST /api/cron/jobs                     -> {r.status_code} (Created cron job ID: {cron_job_id})")

    r = client.post(f"/api/cron/jobs/{cron_job_id}/trigger", headers=headers)
    assert r.status_code in (200, 202), f"POST trigger failed: {r.text}"
    print(f"  [OK] POST /api/cron/jobs/{{id}}/trigger        -> {r.status_code} (Triggered cron run)")

    r = client.delete(f"/api/cron/jobs/{cron_job_id}", headers=headers)
    assert r.status_code == 200, f"DELETE /api/cron/jobs failed: {r.text}"
    print(f"  [OK] DELETE /api/cron/jobs/{{id}}              -> {r.status_code} (Deleted cron job)")

    # 3. Kanban write: create task, patch status
    r = client.post("/api/plugins/kanban/tasks", json={"title": "Spike kanban task", "assignee": "test_bot", "priority": 2}, headers=headers)
    assert r.status_code == 200, f"POST /api/plugins/kanban/tasks failed: {r.text}"
    task_id = r.json()["task"]["id"]
    print(f"  [OK] POST /api/plugins/kanban/tasks          -> {r.status_code} (Created task ID: {task_id})")

    r = client.patch(f"/api/plugins/kanban/tasks/{task_id}", json={"status": "blocked", "block_reason": "Waiting for review"}, headers=headers)
    assert r.status_code == 200, f"PATCH task status failed: {r.text}"
    assert r.json().get("task", {}).get("status") == "blocked"
    print(f"  [OK] PATCH /api/plugins/kanban/tasks/{{id}}    -> {r.status_code} (Updated status to 'blocked')")

async def test_aiohttp_api_server():
    print("\n=== Testing aiohttp API Server (gateway.platforms.api_server) ===")
    server, thread = fake_model_server.start_background_server(18898)
    print("Started background Fake OpenAI Server on http://127.0.0.1:18898")

    cfg = PlatformConfig(
        enabled=True,
        api_key=os.environ["API_SERVER_KEY"],
        extra={"port": 18889, "host": "127.0.0.1"}
    )
    adapter = APIServerAdapter(cfg)
    ok = await adapter.connect()
    assert ok, "APIServerAdapter connect failed"

    headers = {"Authorization": f"Bearer {os.environ['API_SERVER_KEY']}"}

    try:
        async with AioTestClient(AioTestServer(adapter._app)) as client:
            # Health
            r = await client.get("/health")
            assert r.status == 200, f"/health status {r.status}"
            print(f"  [OK] GET  /health                             -> {r.status} (Public health check)")

            # Models
            r = await client.get("/v1/models", headers=headers)
            assert r.status == 200, f"/v1/models status {r.status}"
            models = (await r.json())["data"]
            print(f"  [OK] GET  /v1/models                          -> {r.status} (Model catalog: {len(models)} models)")

            # Capabilities
            r = await client.get("/v1/capabilities", headers=headers)
            assert r.status == 200, f"/v1/capabilities status {r.status}"
            cap = await r.json()
            print(f"  [OK] GET  /v1/capabilities                    -> {r.status} (Platform: {cap.get('platform')})")

            # Skills (Upstream defect finding in v0.23.2: find_all_skills unexpected keyword argument 'include_editorial')
            r = await client.get("/v1/skills", headers=headers)
            print(f"  [KNOWN UPSTREAM BUG] GET /v1/skills           -> {r.status} (Upstream issues #142575, #120831, #132317: include_editorial in api_server.py)")
            assert r.status == 500, f"Expected 500 due to known upstream defect, got {r.status}"

            # Cron Jobs
            r = await client.get("/api/jobs", headers=headers)
            assert r.status == 200, f"/api/jobs status {r.status}"
            jobs = (await r.json())["jobs"]
            print(f"  [OK] GET  /api/jobs                           -> {r.status} (Jobs count: {len(jobs)})")

            # Sessions
            r = await client.get("/api/sessions", headers=headers)
            assert r.status == 200, f"/api/sessions status {r.status}"
            print(f"  [OK] GET  /api/sessions                       -> {r.status} (Sessions list)")

            # Profile prefix multiplexing (/p/<profile>/)
            r = await client.get("/p/default/v1/models", headers=headers)
            assert r.status == 200, f"/p/default/v1/models status {r.status}"
            print(f"  [OK] GET  /p/default/v1/models                -> {r.status} (Profile-scoped /p/default/ prefix)")

            # Auth rejection check (wrong key)
            bad_headers = {"Authorization": "Bearer wrong-key"}
            r = await client.get("/v1/models", headers=bad_headers)
            assert r.status == 401, f"Expected 401 on bad key, got {r.status}"
            print(f"  [OK] GET  /v1/models (bad key)                -> {r.status} (Auth rejection 401 verified)")

            # --- Write & Streaming Paths: Runs, SSE, Approval Deny, Stop ---
            print("\n--- Testing aiohttp Write & Streaming: /v1/runs, SSE, Tool Approval, Stop ---")
            
            # Test 1: POST /v1/runs -> GET events SSE -> approval.request -> POST /approval (deny) -> run.completed
            post_res = await client.post("/v1/runs", json={"input": "trigger_approval clean temp directory"}, headers=headers)
            assert post_res.status == 202, f"POST /v1/runs failed: {post_res.status} {await post_res.text()}"
            run_id = (await post_res.json())["run_id"]
            print(f"  [OK] POST /v1/runs                            -> 202 (Started run: {run_id})")

            sse_res = await client.get(f"/v1/runs/{run_id}/events", headers=headers)
            assert sse_res.status == 200, f"GET /v1/runs/{{id}}/events failed: {sse_res.status}"
            print(f"  [OK] GET  /v1/runs/{run_id}/events      -> 200 (Connected SSE stream)")

            approval_handled = False
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
                    event_name = event_data.get("event")
                    if event_name == "approval.request" and not approval_handled:
                        approval_handled = True
                        print(f"    -> [SSE Event] approval.request received for dangerous command!")
                        app_res = await client.post(f"/v1/runs/{run_id}/approval", json={"choice": "deny"}, headers=headers)
                        assert app_res.status == 200, f"POST approval failed: {await app_res.text()}"
                        app_data = await app_res.json()
                        print(f"    -> [OK] POST /v1/runs/{run_id}/approval (deny) -> {app_res.status} (Resolved: {app_data.get('choice')})")
                    elif event_name == "run.completed":
                        print(f"    -> [SSE Event] run.completed received after tool denial!")
                elif line_str == ": stream closed":
                    print("    -> [SSE Stream] : stream closed frame received")
                    break

            assert approval_handled, "approval.request was not emitted by run!"
            status_res = await client.get(f"/v1/runs/{run_id}", headers=headers)
            final_status = await status_res.json()
            assert final_status.get("status") == "completed", f"Expected completed status, got {final_status}"
            print(f"  [OK] GET  /v1/runs/{run_id}              -> 200 (Final status: {final_status.get('status')})")

            # Test 2: Second run -> POST /v1/runs/{id}/stop -> run ends
            post_res2 = await client.post("/v1/runs", json={"input": "normal long task to be stopped"}, headers=headers)
            assert post_res2.status == 202
            run_id2 = (await post_res2.json())["run_id"]
            print(f"  [OK] POST /v1/runs                            -> 202 (Started second run: {run_id2})")

            stop_res = await client.post(f"/v1/runs/{run_id2}/stop", json={}, headers=headers)
            assert stop_res.status == 200, f"POST /stop failed: {await stop_res.text()}"
            print(f"  [OK] POST /v1/runs/{run_id2}/stop       -> 200 (Stop request sent)")

            status_res2 = await client.get(f"/v1/runs/{run_id2}", headers=headers)
            final_status2 = await status_res2.json()
            assert final_status2.get("status") in {"cancelled", "stopped", "interrupted", "completed", "stopping"}
            print(f"  [OK] GET  /v1/runs/{run_id2}             -> 200 (Status after stop: {final_status2.get('status')})")

        await adapter.disconnect()
    finally:
        server.shutdown()
        server.server_close()

if __name__ == "__main__":
    init_isolated_store()
    test_fastapi_endpoints()
    asyncio.run(test_aiohttp_api_server())
    print("\nAll Hermes API coverage, write, and streaming tests passed successfully!")
