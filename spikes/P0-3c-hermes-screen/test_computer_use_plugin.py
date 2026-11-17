"""Spike P0-3c: Stub Hermes Computer Use Backend Plugin.

Proves:
1. Upstream Hermes computer_use plugin architecture discovers and selects neo_vnc without edits.
2. In a real agent turn driven by an OpenAI-compatible fake model server, Hermes invokes
   neo_vnc's click and capture backend methods.
"""

import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path

HERMES_HOME = r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.hermes-home"
os.environ["HERMES_HOME"] = HERMES_HOME
os.environ["API_SERVER_KEY"] = "hermes-test-api-secret-key-32chars!!"
os.environ["HERMES_INTERACTIVE"] = "1"

sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-upstream-cache\hermes-agent@v0.23.2")
sys.path.insert(0, r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\P0-3b-hermes-api")

import fake_model_server

def test_computer_use():
    print("=== Testing Spike P0-3c: neo_vnc Computer Use Plugin in Real Turn ===")

    # 1. Start Fake Model Server
    fake_model, fake_thread = fake_model_server.start_background_server(18898)
    print("1. Started Fake Model Server on 127.0.0.1:18898")

    # 2. Install neo_vnc plugin into $HERMES_HOME/plugins/neo_vnc
    plugin_src = Path(r"C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\P0-3c-hermes-screen\neo_vnc_plugin")
    plugin_dest = Path(HERMES_HOME) / "plugins" / "neo_vnc"
    if plugin_dest.exists():
        shutil.rmtree(plugin_dest)
    shutil.copytree(plugin_src, plugin_dest)
    print(f"2. Installed neo_vnc plugin into {plugin_dest} (zero edits to Hermes upstream)")

    # 3. Configure computer_use.backend: neo_vnc in config.yaml
    config_yaml = Path(HERMES_HOME) / "config.yaml"
    config_yaml.write_text(
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
    print("3. Configured computer_use.backend: neo_vnc in config.yaml")

    # 4. Verify provider discovery and active provider
    from plugins.computer_use import get_active_provider, discover_computer_use_providers
    providers = discover_computer_use_providers()
    print(f"4a. Discovered computer_use providers: {providers}")
    active_provider = get_active_provider()
    print(f"4b. Active computer_use provider resolved: name='{active_provider.name}'")
    assert active_provider.name == "neo_vnc", f"Expected active provider 'neo_vnc', got '{active_provider.name}'"

    # 5. Setup approval callback for automated execution
    from tools.computer_use import tool as cu_tool
    cu_tool.set_approval_callback(lambda command, description, **kw: "once")

    try:
        # 6. Execute a real turn using AIAgent with fake model emitting computer_use tool call
        print("5. Initializing AIAgent and running turn with trigger_computer_use...")
        from run_agent import AIAgent
        agent = AIAgent(
            model="fake-model",
            base_url="http://127.0.0.1:18898/v1",
            api_key="dummy-key",
            max_iterations=2,
        )

        turn_result = agent.run_conversation("trigger_computer_use click the Submit button")
        print(f"6. Agent turn completed. Result: {turn_result.get('completed')}")

        # 7. Check calls recorded by neo_vnc backend
        neo_vnc_mod = sys.modules.get("_hermes_user_computer_use.neo_vnc")
        assert neo_vnc_mod is not None, "neo_vnc plugin module was not imported by Hermes!"
        calls = neo_vnc_mod.CALLS
        print(f"7. Recorded calls in NeoVncBackend ({len(calls)}):")
        for c in calls:
            print(f"   - {c}")

        assert any(action == "click" for action, _ in calls), "No 'click' action recorded in NeoVncBackend!"
        assert any(action == "capture" for action, _ in calls), "No 'capture' action recorded in NeoVncBackend!"
        print("\n[SUCCESS] Runtime proof confirmed: neo_vnc backend plugin handled click and capture during real agent turn!")

    finally:
        cu_tool.set_approval_callback(None)
        fake_model.shutdown()
        fake_model.server_close()

if __name__ == "__main__":
    test_computer_use()
