"""Neo Channels: offers each inbound WhatsApp message to the Neo gateway first.

Loaded through Hermes' public plugin seam (user plugin dir + ``plugins.enabled``) and its
``pre_gateway_dispatch`` hook (hermes_cli/plugins.py:142-145, gateway/run_inbound_hooks.py:74-110
at v0.23.2). The hook runs before Hermes' own authorization; returning ``{"action": "skip"}`` drops
the event from Hermes dispatch, ``None`` keeps normal dispatch. Neo answers ``skip`` only for an
allowlisted sender addressing @neo while the Inbox is running; every other message, and any failure
to reach Neo, stays with Hermes.
"""

import asyncio
import json
import logging
from pathlib import Path
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

_PLATFORMS = {"whatsapp"}


def _binding():
    from hermes_constants import get_hermes_home

    file = Path(get_hermes_home()) / "plugins" / "neo-channels" / "binding.json"
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _post(binding, payload):
    request = Request(
        binding["endpoint"],
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json", "authorization": "Bearer " + binding["token"]},
    )
    with urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


async def _on_dispatch(event=None, **_kwargs):
    source = getattr(event, "source", None)
    platform = getattr(getattr(source, "platform", None), "value", None)
    if platform not in _PLATFORMS or not isinstance(getattr(event, "text", None), str):
        return None
    binding = _binding()
    if not binding:
        return None
    payload = {
        "profile": binding.get("profile", ""),
        "platform": platform,
        "chatId": source.chat_id or "",
        "chatType": source.chat_type or "dm",
        "senderId": source.user_id or "",
        "messageId": event.message_id or getattr(source, "message_id", None) or "",
        "text": event.text,
    }
    try:
        result = await asyncio.to_thread(_post, binding, payload)
    except Exception as exc:  # Neo disabled or unreachable: Hermes keeps the message.
        logger.warning("neo-channels: Neo gateway unavailable (%s); normal dispatch", type(exc).__name__)
        return None
    if isinstance(result, dict) and result.get("action") == "skip":
        return {"action": "skip", "reason": "neo-inbox"}
    return None


def register(ctx):
    ctx.register_hook("pre_gateway_dispatch", _on_dispatch)
