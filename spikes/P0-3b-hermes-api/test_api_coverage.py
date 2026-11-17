import asyncio
import os
import sys
from pathlib import Path

# Ensure clean isolated Hermes environment
HERMES_HOME = r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.hermes-home"
os.environ["HERMES_HOME"] = HERMES_HOME
os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = "test-token-12345678901234567890"
os.environ["API_SERVER_KEY"] = "0123456789abcdef0123456789abcdef"
os.environ["API_SERVER_ENABLED"] = "true"

sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2")

from hermes_state import SessionDB
from starlette.testclient import TestClient
from aiohttp.test_utils import TestClient as AioTestClient, TestServer
from hermes_cli import web_server
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter

def init_isolated_store():
    home = Path(HERMES_HOME)
    home.mkdir(parents=True, exist_ok=True)
    db_path = home / "state.db"
    if not db_path.exists():
        db = SessionDB(db_path)
        db.close()
        print(f"Initialized isolated state.db at {db_path}")

def test_fastapi_endpoints():
    print("=== Testing FastAPI Dashboard Backend (hermes_cli.web_server) ===")
    client = TestClient(web_server.app)
    headers = {"Authorization": "Bearer " + web_server._SESSION_TOKEN}

    tests = [
        # 1. Bots / Profiles
        ("GET", "/api/profiles", 200, "1. bots/profiles: list profiles"),
        ("GET", "/api/profiles/active", 200, "1. bots/profiles: get active profile"),
        ("GET", "/api/profiles/default/setup-command", 200, "1. bots/profiles: profile setup command"),
        # 2. Chat / Sessions
        ("GET", "/api/sessions", 200, "2. chat/runs: list sessions"),
        ("GET", "/api/sessions/stats", 200, "2. chat/runs: session stats"),
        ("GET", "/api/sessions/empty/count", 200, "2. chat/runs: empty sessions count"),
        # 3. Cron
        ("GET", "/api/cron/jobs", 200, "3. cron: list cron jobs"),
        ("GET", "/api/cron/delivery-targets", 200, "3. cron: delivery targets"),
        # 4. Kanban
        ("GET", "/api/plugins/kanban/boards", 200, "4. kanban: list boards"),
        ("GET", "/api/plugins/kanban/board", 200, "4. kanban: get active board"),
        ("GET", "/api/plugins/kanban/stats", 200, "4. kanban: stats"),
        ("GET", "/api/plugins/kanban/workers/active", 200, "4. kanban: active workers"),
        # 5. Skills (+ curator, learning graph)
        ("GET", "/api/skills", 200, "5. skills: list skills"),
        ("GET", "/api/curator", 200, "5. skills: curator status"),
        ("GET", "/api/learning/graph", 200, "5. skills: learning graph"),
        ("GET", "/api/skills/hub/official", 200, "5. skills: skills hub official"),
        # 6. Memory providers
        ("GET", "/api/memory", 200, "6. memory: memory status"),
        ("GET", "/api/memory/providers/honcho/config", 200, "6. memory: honcho config"),
        # 7. Platforms / Channels
        ("GET", "/api/messaging/platforms", 200, "7. platforms: messaging platforms"),
        # 8. Models
        ("GET", "/api/local-models/status", 200, "8. models: local models status"),
        ("GET", "/api/credentials/pool", 200, "8. models: credentials pool"),
    ]

    for method, path, expected_status, label in tests:
        res = client.request(method, path, headers=headers)
        assert res.status_code == expected_status, f"{label} failed: {res.status_code} != {expected_status}: {res.text}"
        data_summary = str(res.json())[:80] if res.headers.get("content-type", "").startswith("application/json") else res.text[:80]
        print(f"  [OK] {method:4} {path:35} -> {res.status_code} ({label}): {data_summary}")

async def test_aiohttp_api_server():
    print("\n=== Testing aiohttp API Server (gateway.platforms.api_server) ===")
    cfg = PlatformConfig(
        enabled=True,
        api_key=os.environ["API_SERVER_KEY"],
        extra={"port": 18889, "host": "127.0.0.1"}
    )
    adapter = APIServerAdapter(cfg)
    ok = await adapter.connect()
    assert ok, "APIServerAdapter failed to connect"

    async with AioTestClient(TestServer(adapter._app)) as client:
        # Unauthenticated public endpoint
        r = await client.get("/health")
        assert r.status == 200, f"/health status {r.status}"
        print(f"  [OK] GET  /health                             -> {r.status} (Public health check)")

        # Authenticated endpoints with API_SERVER_KEY
        headers = {"Authorization": f"Bearer {os.environ['API_SERVER_KEY']}"}
        
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
        print(f"  [FINDING] GET /v1/skills                      -> {r.status} (Upstream bug: include_editorial in api_server.py)")
        assert r.status == 500, f"Expected 500 due to upstream defect, got {r.status}"

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

    await adapter.disconnect()

if __name__ == "__main__":
    init_isolated_store()
    test_fastapi_endpoints()
    asyncio.run(test_aiohttp_api_server())
    print("\nAll Hermes API coverage tests passed successfully!")
