import json
import os
import shutil
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERMES_HOME = r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.hermes-home"
os.environ["HERMES_HOME"] = HERMES_HOME

sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2")
sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\P0-3b-hermes-api")

import fake_model_server

RECORDED_WRITES = []
RECORDED_RECALLS = []
FAKE_PORT = 18899

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

def main():
    print("=== Testing Spike P0-3f: Stub Hermes Memory-Provider Plugin ===")
    
    # 1. Start Fake L1 HTTP Server
    server = HTTPServer(("127.0.0.1", FAKE_PORT), FakeL1Server)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"1. Started Fake L1 Local Memory HTTP Server on 127.0.0.1:{FAKE_PORT}")

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
        "custom_providers:\n"
        "  custom:\n"
        "    base_url: http://127.0.0.1:18898/v1\n"
        "    api_key: dummy-key\n"
        "memory:\n"
        "  provider: neo_l1\n"
    )
    config_yaml_path.write_text(config_content, encoding="utf-8")
    print("3. Configured memory.provider: neo_l1 and custom model in config.yaml")

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
    assert provider.is_available() is True, "Provider report not available"
    print("5. Provider loaded: name='neo_l1', is_available=True")

    # 6. Test prefetch (serves context from fake HTTP endpoint)
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
    time.sleep(0.2)
    print("7a. Dispatched on_memory_write via MemoryManager")

    # 7b. Test sync_turn
    mgr.sync_all(
        user_content="Design the Neo Meta Harness architecture",
        assistant_content="The architecture is modular, using Cordis kernel and Astryx design system."
    )
    time.sleep(0.2)
    print("7b. Dispatched sync_turn via MemoryManager")

    # 8. Verify recorded direct writes in Fake L1 Server
    with urllib.request.urlopen(f"http://127.0.0.1:{FAKE_PORT}/writes") as resp:
        writes_data = json.loads(resp.read().decode("utf-8"))["writes"]

    print(f"8. Verified writes recorded on Fake L1 Server ({len(writes_data)} events):")
    for w in writes_data:
        print(f"   - {w}")

    assert len(writes_data) == 2, f"Expected 2 writes, got {len(writes_data)}"
    assert writes_data[0]["type"] == "memory_write"
    assert writes_data[0]["content"] == "Prefers Cordis kernel and Astryx UI"
    assert writes_data[1]["type"] == "turn"
    assert "Design the Neo Meta Harness" in writes_data[1]["user"]

    # 9. Real Agent Turn driven by Fake OpenAI Server triggering neo_l1
    print("\n9. Executing real agent turn with fake model server...")
    fake_model, fake_model_thread = fake_model_server.start_background_server(18898)
    try:
        from run_agent import AIAgent
        agent = AIAgent(
            model="fake-model",
            base_url="http://127.0.0.1:18898/v1",
            api_key="dummy-key",
            max_iterations=1,
        )
        assert agent._memory_manager is not None
        assert "neo_l1" in [p.name for p in agent._memory_manager.providers]
        print("   AIAgent initialized with neo_l1 active memory provider.")

        result = agent.run_conversation("What are the user preferences for Neo architecture?")
        assert result.get("completed") is True
        print("   Real agent turn completed successfully.")
        time.sleep(0.3)

        with urllib.request.urlopen(f"http://127.0.0.1:{FAKE_PORT}/writes") as resp:
            data = json.loads(resp.read().decode("utf-8"))
            all_writes = data["writes"]
            all_recalls = data["recalls"]

        print(f"   Total recalls on Fake L1 Server: {len(all_recalls)}")
        print(f"   Total writes on Fake L1 Server: {len(all_writes)}")
        assert len(all_recalls) >= 1, "Agent turn did not trigger recall prefetch on L1 server!"
        assert len(all_writes) >= 3, "Agent turn did not record turn completion write on L1 server!"
        last_turn_write = all_writes[-1]
        assert last_turn_write["type"] == "turn"
        assert "What are the user preferences" in last_turn_write["user"]
        print(f"   Verified real turn write recorded: {last_turn_write['type']} (user: '{last_turn_write['user'][:40]}...')")
    finally:
        fake_model.shutdown()
        fake_model.server_close()
        server.shutdown()
        server.server_close()

    print("\n[SUCCESS] Spike P0-3f completed: Stub memory-provider plugin loaded by path without Hermes edits, served context from local HTTP server, and recorded memory writes during real agent turn!")

if __name__ == "__main__":
    main()
