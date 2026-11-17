# P0-3f Hermes Memory Provider Plugin
Verdict: WORKS
Question: Can a stub Hermes memory-provider plugin be installed by path with zero Hermes edits, serve context from a local HTTP endpoint, and record memory writes and completed turns during a real agent turn?
Pinned ref: hermes-agent@v0.23.2 (commit `ae2a81ccc00e9b7c06301523e5bb09608397149c`)
Seam:
- `plugins/memory/__init__.py`: `find_provider_dir()`, `load_memory_provider()`, and user plugin directory discovery at `$HERMES_HOME/plugins/<name>/`
- `agent/memory_provider.py`: `MemoryProvider` ABC (`is_available`, `initialize`, `prefetch`, `on_memory_write`, `sync_turn`, `get_tool_schemas`, `handle_tool_call`, `register(ctx)`)
- `agent/memory_manager.py`: `MemoryManager` lifecycle integration (`add_provider`, `initialize_all`, `prefetch`, `on_memory_write`, `sync_all`)
- `gateway/platforms/api_server.py`: `APIServerAdapter` and `session_api_turn.py`: `/v1/runs` dispatching turns with memory hooks
- `agent/turn_context.py`: Turn execution hooks (`turn_context.py:1082` `agent._memory_manager.prefetch_all` and `run_agent.py:902` `_sync_external_memory_for_turn`)

## Mechanism
Hermes discovers external memory provider plugins from `$HERMES_HOME/plugins/<name>/` (or project `./.hermes/plugins/<name>/` if enabled) before falling back to entry points.
1. The stub plugin `neo_l1` is placed under `$HERMES_HOME/plugins/neo_l1/` with `plugin.yaml` and `__init__.py`.
2. In `~/.hermes/config.yaml`, setting `memory.provider: neo_l1` activates it as the profile's external memory provider.
3. During turn execution:
   - `prefetch(query)` queries the local L1 HTTP endpoint `GET /context?q=...` and formats the recalled context for LLM prompt injection (`## Neo L1 Memory Context`).
   - `on_memory_write(action, target, content)` mirrors memory tool actions via `POST /write` to the local L1 HTTP endpoint.
   - `sync_all(user_content, assistant_content)` forwards completed turn dialogues via `POST /write` to the local L1 HTTP endpoint in a non-blocking background thread.
4. When executed in a live agent turn through the `api_server` (`POST /v1/runs`), Hermes invokes `prefetch_all` before the first LLM call, injects the recalled context into the prompt, and invokes `sync_all` after the assistant completes the turn, driven by our local `fake_model_server.py`.

## Evidence
Ran `test_memory_plugin.py` against isolated Hermes `v0.23.2` home (`spikes/.hermes-home`), `fake_model_server.py`, and `FakeL1Server`:

```powershell
=== Testing Spike P0-3f: Stub Hermes Memory-Provider Plugin ===
1. Started Fake L1 Local Memory HTTP Server on 127.0.0.1:18899
2. Installed plugin into C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.hermes-home\plugins\neo_l1 (zero edits to Hermes upstream)
3. Configured memory.provider: neo_l1 and custom model provider in config.yaml
4. Hermes successfully discovered provider at: C:\Users\Neo\Desktop\nmh-wt\gemini\spikes\.hermes-home\plugins\neo_l1
5. Provider loaded: name='neo_l1', is_available=True
6. prefetch() returned:
   ## Neo L1 Memory Context
NEO-L1-RECALL: Found knowledge for query 'architecture design'. User prefers modular TypeScript extensions.
7a. Dispatched on_memory_write via MemoryManager
7b. Dispatched sync_turn via MemoryManager
8. Verified direct writes recorded on Fake L1 Server (2 events):
   - {'type': 'memory_write', 'action': 'add', 'target': 'user', 'content': 'Prefers Cordis kernel and Astryx UI', 'session_id': 'test-session-spike-f', 'metadata': {}}
   - {'type': 'turn', 'session_id': 'test-session-spike-f', 'user': 'Design the Neo Meta Harness architecture', 'assistant': 'The architecture is modular, using Cordis kernel and Astryx design system.'}

9. Executing real turn through api_server (POST /v1/runs -> SSE stream)...
   Connected APIServerAdapter (api_server)
   Dispatching POST /v1/runs with prompt: 'What are the user preferences for Neo architecture?'
   Run started: run_id=run_f9c6479e861f413b9aaba122985bfbb9
🧠 Neo L1 — recalled 1 memory
   Run final status: completed
   (a) Fake L1 Recalls recorded (2): ['architecture design', 'What are the user preferences for Neo architecture?']
   (b) [CONFIRMED] Injected context found in model request:
       >>> What are the user preferences for Neo architecture?

<memory-context>
[System note: The following is recalled memory con...
   (c) [CONFIRMED] Turn write landed on Fake L1 Server (1):
       - session_id='run_f9c6479e861f413b9aaba122985bfbb9', user='What are the user preferences for Neo ar...'

[SUCCESS] Spike P0-3f completed: Stub memory-provider plugin loaded by path without Hermes edits, served context from local HTTP server, and recorded memory writes during real /v1/runs agent turn!
```

## Risks
1. **Single External Provider Limit**: `MemoryManager.add_provider()` enforces a strict invariant: only ONE external memory provider can be active at a time alongside the built-in store (`agent/memory_manager.py:285`). A second external provider logs a warning and returns without being registered.
   - *Impact on Neo*: Neo's L1 memory provider must act as the sole external provider to Hermes, and internally multiplex L1 local fast memory and L2 Honcho synchronization.
2. **Background Thread Pool & Shutdown**: Memory writes (`sync_all`) run asynchronously in a bounded `ThreadPoolExecutor`. If an agent shuts down abruptly, un-flushed writes might be lost if `shutdown_all()` is not awaited. Neo's plugin should implement fast local spooling.
3. **Redaction of Secrets**: Hermes's `MemoryManager` automatically runs `_redact_for_provider` across `user_content`, `assistant_content`, and messages before calling `sync_turn`, stripping tokens and credentials.

## Architecture Impact
- Confirms `docs/02-architecture.md` Section 8 ("Memory architecture"): Neo's L1 memory can be completely plugged into Hermes via `$HERMES_HOME/plugins/neo_l1/` with zero modifications to Hermes code.
- No monkeypatching or forks required. The plugin interface is clean, stable, and explicitly designed for third-party providers.

## Contract Test Idea
A fast contract test in `neo check` that creates a temporary `$HERMES_HOME/plugins/neo_contract_test`, verifies `find_provider_dir("neo_contract_test")` resolves, and asserts `MemoryProvider` ABC method signatures (`is_available`, `prefetch`, `on_memory_write`, `sync_turn`) have not changed.
