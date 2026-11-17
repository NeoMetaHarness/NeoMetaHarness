"""Spike P0-3f: Stub Hermes Memory-Provider Plugin.

Tests:
1. Provider directory discovery under $HERMES_HOME/plugins/neo_l1 (zero edits to Hermes).
2. MemoryProvider ABC implementation (prefetch, on_memory_write, sync_turn).
3. MemoryManager lifecycle and dispatch.
4. End-to-end runtime turn through Hermes api_server (POST /v1/runs -> SSE stream):
   (a) Fake L1 HTTP server receives GET /context?q=... prefetch call.
   (b) Injected context reaches Fake Model Server request prompt.
   (c) Turn completion write lands on Fake L1 HTTP server via POST /write.
"""

import asyncio
import json
import os
import shutil
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

HERMES_HOME = r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.hermes-home"
os.environ["HERMES_HOME"] = HERMES_HOME
os.environ["API_SERVER_KEY"] = "hermes-test-api-secret-key-32chars!!"

sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2")
sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\P0-3b-hermes-api")

import aiohttp
from aiohttp.test_utils import TestClient as AioTestClient, TestServer as AioTestServer
from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
import fake_model_server

RECORDED_WRITES = []
RECORDED_RECALLS = []
FAKE_L1_PORT = 18899
FAKE_MODEL_PORT = 18898

class FakeL1Server(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/context":
            params = urllib.parse.parse_qs(parsed.query)
            q = params.get("q", [""])[0]
            RECORDED_RECALLS.append(q)
            resp = {"context": f"NEO-L1-RECALL: Found knowledge for query '{q}'. User prefers modular TypeScript extensions."}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp).encode("utf-8"))
        elif parsed.path == "/writes":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"writes": RECORDED_WRITES, "recalls": RECORDED_RECALLS}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/write":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode("utf-8")
            data = json.loads(body)
            RECORDED_WRITES.append(data)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

async def run_tests():
    print("=== Testing Spike P0-3f: Stub Hermes Memory-Provider Plugin ===")
    
    # 1. Start Fake L1 HTTP Server
    server = HTTPServer(("127.0.0.1", FAKE_L1_PORT), FakeL1Server)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"1. Started Fake L1 Local Memory HTTP Server on 127.0.0.1:{FAKE_L1_PORT}")

    # 2. Install plugin by copying into $HERMES_HOME/plugins/neo_l1
    plugin_src = Path(r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\P0-3f-hermes-memory\neo_l1_plugin")
    plugins_dest = Path(HERMES_HOME) / "plugins" / "neo_l1"
    if plugins_dest.exists():
        shutil.rmtree(plugins_dest)
    shutil.copytree(plugin_src, plugins_dest)
    print(f"2. Installed plugin into {plugins_dest} (zero edits to Hermes upstream)")

    # 3. Configure memory.provider: neo_l1 in config.yaml
    config_yaml_path = Path(HERMES_HOME) / "config.yaml"
    config_content = (
        "model:\n"
        "  provider: custom\n"
        "  default: fake-model\n"
        "providers:\n"
        "  custom:\n"
        "    base_url: http://127.0.0.1:18898/v1\n"
        "    api_key: dummy-key\n"
        "memory:\n"
        "  provider: neo_l1\n"
    )
    config_yaml_path.write_text(config_content, encoding="utf-8")
    print("3. Configured memory.provider: neo_l1 and custom model provider in config.yaml")

    # 4. Verify Hermes discovers the provider
    from plugins.memory import find_provider_dir, load_memory_provider, _get_active_memory_provider
    active = _get_active_memory_provider()
    assert active == "neo_l1", f"Expected active provider 'neo_l1', got {active}"
    
    provider_dir = find_provider_dir("neo_l1")
    assert provider_dir is not None and provider_dir.exists(), "Hermes failed to find provider_dir for neo_l1"
    print(f"4. Hermes successfully discovered provider at: {provider_dir}")

    # 5. Load and initialize provider instance via Hermes
    provider = load_memory_provider("neo_l1")
    assert provider is not None, "load_memory_provider('neo_l1') returned None"
    assert provider.name == "neo_l1", f"Provider name mismatch: {provider.name}"
    assert provider.is_available() is True, "Provider reports not available"
    print("5. Provider loaded: name='neo_l1', is_available=True")

    # 6. Test prefetch directly
    session_id = "test-session-spike-f"
    provider.initialize(session_id=session_id, hermes_home=HERMES_HOME)
    context = provider.prefetch("architecture design", session_id=session_id)
    print(f"6. prefetch() returned:\n   {context.strip()}")
    assert "NEO-L1-RECALL" in context, "Expected prefetch to return context from fake L1 server"
    assert "User prefers modular TypeScript extensions" in context

    # 7. Test MemoryManager integration and write hooks
    from agent.memory_manager import MemoryManager
    mgr = MemoryManager()
    mgr.add_provider(provider)
    mgr.initialize_all(session_id=session_id, hermes_home=HERMES_HOME)
    
    # 7a. Test on_memory_write
    mgr.on_memory_write(action="add", target="user", content="Prefers Cordis kernel and Astryx UI")
    time.sleep(0.1)
    print("7a. Dispatched on_memory_write via MemoryManager")

    # 7b. Test sync_turn
    mgr.sync_all(
        user_content="Design the Neo Meta Harness architecture",
        assistant_content="The architecture is modular, using Cordis kernel and Astryx design system."
    )
    time.sleep(0.1)
    print("7b. Dispatched sync_turn via MemoryManager")

    # 8. Verify recorded direct writes in Fake L1 Server
    with urllib.request.urlopen(f"http://127.0.0.1:{FAKE_L1_PORT}/writes") as resp:
        writes_data = json.loads(resp.read().decode("utf-8"))["writes"]

    print(f"8. Verified direct writes recorded on Fake L1 Server ({len(writes_data)} events):")
    for w in writes_data:
        print(f"   - {w}")

    assert len(writes_data) == 2, f"Expected 2 writes, got {len(writes_data)}"
    assert writes_data[0]["type"] == "memory_write"
    assert writes_data[0]["content"] == "Prefers Cordis kernel and Astryx UI"
    assert writes_data[1]["type"] == "turn"
    assert "Design the Neo Meta Harness" in writes_data[1]["user"]

    # 9. Real Agent Turn through api_server (/v1/runs) driven by Fake OpenAI Server
    print("\n9. Executing real turn through api_server (POST /v1/runs -> SSE stream)...")
    fake_model, fake_model_thread = fake_model_server.start_background_server(FAKE_MODEL_PORT)
    
    cfg = PlatformConfig(
        enabled=True,
        api_key=os.environ["API_SERVER_KEY"],
        extra={"port": 18889, "host": "127.0.0.1"}
    )
    adapter = APIServerAdapter(cfg)
    ok = await adapter.connect()
    assert ok, "APIServerAdapter connect failed"
    print("   Connected APIServerAdapter (api_server)")

    headers = {
        "Authorization": f"Bearer {os.environ['API_SERVER_KEY']}",
        "Content-Type": "application/json",
    }

    try:
        async with AioTestClient(AioTestServer(adapter._app)) as client:
            user_prompt = "What are the user preferences for Neo architecture?"
            print(f"   Dispatching POST /v1/runs with prompt: '{user_prompt}'")
            post_res = await client.post("/v1/runs", json={"input": user_prompt}, headers=headers)
            assert post_res.status == 202, f"POST /v1/runs failed: {post_res.status} {await post_res.text()}"
            run_id = (await post_res.json())["run_id"]
            print(f"   Run started: run_id={run_id}")

            # Stream events until run.completed
            sse_res = await client.get(f"/v1/runs/{run_id}/events", headers=headers)
            assert sse_res.status == 200
            while True:
                line = await sse_res.content.readline()
                if not line:
                    break
                line_str = line.decode("utf-8").strip()
                if line_str.startswith("event: "):
                    ev_name = line_str.replace("event: ", "").strip()
                    if ev_name == "run.completed":
                        print(f"   SSE Event received: {ev_name}")
                        break
                elif line_str == ": stream closed":
                    break

            status_res = await client.get(f"/v1/runs/{run_id}", headers=headers)
            final_status = (await status_res.json()).get("status")
            print(f"   Run final status: {final_status}")
            assert final_status == "completed"

            # Allow background worker to flush turn write
            await asyncio.sleep(0.5)

            # (a) Check fake L1 received GET /context during prefetch
            print(f"   (a) Fake L1 Recalls recorded ({len(RECORDED_RECALLS)}): {RECORDED_RECALLS}")
            assert any(user_prompt in r for r in RECORDED_RECALLS), "Fake L1 did not receive prefetch for prompt!"

            # (b) Check injected context reached model request prompt in fake model server
            found_recall_in_model = False
            for req in fake_model_server.RECORDED_REQUESTS:
                for m in req.get("messages", []):
                    c = str(m.get("content", ""))
                    if "NEO-L1-RECALL" in c:
                        found_recall_in_model = True
                        print(f"   (b) [CONFIRMED] Injected context found in model request:")
                        print(f"       >>> {c[:120]}...")
            assert found_recall_in_model, "Injected context 'NEO-L1-RECALL' did not reach model request prompt!"

            # (c) Check turn write landed on fake L1 HTTP server
            e2e_turn_writes = [w for w in RECORDED_WRITES if w.get("type") == "turn" and user_prompt in w.get("user", "")]
            print(f"   (c) [CONFIRMED] Turn write landed on Fake L1 Server ({len(e2e_turn_writes)}):")
            for tw in e2e_turn_writes:
                print(f"       - session_id='{tw.get('session_id')}', user='{tw.get('user')[:40]}...'")
            assert len(e2e_turn_writes) > 0, "No turn write recorded on Fake L1 Server for /v1/runs turn!"

    finally:
        await adapter.disconnect()
        fake_model.shutdown()
        fake_model.server_close()
        server.shutdown()
        server.server_close()

    print("\n[SUCCESS] Spike P0-3f completed: Stub memory-provider plugin loaded by path without Hermes edits, served context from local HTTP server, and recorded memory writes during real /v1/runs agent turn!")

if __name__ == "__main__":
    asyncio.run(run_tests())
