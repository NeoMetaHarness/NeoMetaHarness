import json
import logging
import urllib.parse
import urllib.request
from typing import Any, Optional

from agent.memory_provider import MemoryProvider, RecallStatus

logger = logging.getLogger(__name__)

L1_ENDPOINT = "http://127.0.0.1:18899"

class NeoL1MemoryProvider(MemoryProvider):
    """Stub memory provider that bridges Hermes to Neo's L1 local memory service."""

    def __init__(self, config: Optional[dict[str, Any]] = None):
        self._config = config or {}
        self._endpoint = self._config.get("endpoint", L1_ENDPOINT)
        self._session_id = ""
        self._last_count = 0

    @property
    def name(self) -> str:
        return "neo_l1"

    def is_available(self) -> bool:
        # Check configuration only, no blocking network calls per Hermes contract
        return True

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id

    def system_prompt_block(self) -> str:
        return "# Neo L1 Memory Active\nContext is provided via local memory fabric."

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not query:
            return ""
        try:
            url = f"{self._endpoint}/context?q=" + urllib.parse.quote(query)
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                context = data.get("context", "")
                self._last_count = 1 if context else 0
                return f"## Neo L1 Memory Context\n{context}" if context else ""
        except Exception as e:
            logger.warning("NeoL1MemoryProvider prefetch failed: %s", e)
            return ""

    def recall_status(self) -> Optional[RecallStatus]:
        if self._last_count > 0:
            return RecallStatus(provider_label="Neo L1", count=self._last_count)
        return None

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "", **kwargs) -> None:
        payload = {
            "type": "turn",
            "session_id": session_id or self._session_id,
            "user": user_content,
            "assistant": assistant_content
        }
        self._post_write(payload)

    def on_memory_write(self, action: str, target: str, content: str, metadata: Optional[dict[str, Any]] = None) -> None:
        payload = {
            "type": "memory_write",
            "action": action,
            "target": target,
            "content": content,
            "session_id": self._session_id,
            "metadata": metadata or {}
        }
        self._post_write(payload)

    def _post_write(self, payload: dict[str, Any]) -> None:
        try:
            url = f"{self._endpoint}/write"
            body = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                pass
        except Exception as e:
            logger.warning("NeoL1MemoryProvider write failed: %s", e)

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [{
            "type": "function",
            "function": {
                "name": "neo_l1_query",
                "description": "Query Neo L1 local memory fabric",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"}
                    },
                    "required": ["query"]
                }
            }
        }]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs) -> str:
        if tool_name == "neo_l1_query":
            q = args.get("query", "")
            return json.dumps({"result": self.prefetch(q)})
        return json.dumps({"error": f"Unknown tool {tool_name}"})

    def shutdown(self) -> None:
        pass

def register(ctx) -> None:
    """Register Neo L1 memory provider with Hermes plugin manager."""
    ctx.register_memory_provider(NeoL1MemoryProvider())
