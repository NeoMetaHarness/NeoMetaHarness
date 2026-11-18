"""Neo's sole Hermes memory provider, loaded by the pinned public plugin seam."""

import json
import logging
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from agent.memory_provider import MemoryProvider, RecallStatus

logger = logging.getLogger(__name__)


class NeoMemory(MemoryProvider):
    def __init__(self):
        self.binding = None
        self.session_id = ""
        self.count = 0

    @property
    def name(self):
        return "neo"

    def is_available(self):
        return True

    def initialize(self, session_id, **kwargs):
        home = Path(kwargs["hermes_home"])
        file = home / "plugins" / "neo" / "binding.json"
        self.binding = json.loads(file.read_text(encoding="utf-8"))
        self.session_id = session_id

    def system_prompt_block(self):
        return ""

    def _request(self, path, payload=None, query=None):
        if not self.binding:
            return {}
        url = self.binding["endpoint"] + path
        if query:
            url += "?" + urlencode(query)
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(url, data=data, headers={
            "Authorization": "Bearer " + self.binding["token"],
            "Content-Type": "application/json",
        }, method="POST" if payload is not None else "GET")
        with urlopen(request, timeout=3) as response:
            return json.load(response)

    def prefetch(self, query, *, session_id=""):
        try:
            result = self._request("/context", query={"profile": self.binding["profile"], "q": query})
            text = result.get("context", "")
            self.count = len(text.splitlines()) if text else 0
            return "## Neo memory\n" + text if text else ""
        except Exception as error:
            logger.warning("Neo memory recall unavailable: %s", error)
            self.count = 0
            return ""

    def recall_status(self):
        return RecallStatus(provider_label="Neo", count=self.count) if self.count else None

    def sync_turn(self, user_content, assistant_content, *, session_id="", **kwargs):
        if not assistant_content.strip():
            return
        try:
            self._request("/write", payload={
                "type": "turn", "profile": self.binding["profile"],
                "session_id": session_id or self.session_id,
                "user": user_content[:16000], "assistant": assistant_content[:16000],
            })
        except Exception as error:
            logger.warning("Neo memory write unavailable: %s", error)

    def get_tool_schemas(self):
        return []

    def handle_tool_call(self, tool_name, args, **kwargs):
        return json.dumps({"error": "Unknown Neo memory tool"})

    def shutdown(self):
        self.binding = None


def register(ctx):
    ctx.register_memory_provider(NeoMemory())
