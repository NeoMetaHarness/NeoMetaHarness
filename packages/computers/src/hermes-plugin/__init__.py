"""Neo-owned Hermes computer-use provider, routed via a scoped Gateway capability."""
import base64
import json
from pathlib import Path
from urllib.request import Request, urlopen

from tools.computer_use.backend import (
    ActionResult, CaptureResult, ComputerUseBackend, ComputerUseProvider,
)


class NeoGatewayBackend(ComputerUseBackend):
    def __init__(self, mode):
        self.mode = mode
        self.binding_file = Path(__file__).with_name("binding.json")

    def start(self):
        pass

    def stop(self):
        pass

    def is_available(self):
        return self.binding_file.is_file()

    def _act(self, payload):
        # Read per call so reassignment/kill takes effect for the next action.
        if not self.binding_file.is_file():
            raise RuntimeError("No computer assigned to this bot. Attach a computer and assign it before using computer_use.")
        binding = json.loads(self.binding_file.read_text(encoding="utf-8"))
        request = Request(
            binding["endpoint"],
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": "Bearer " + binding["token"],
                     "Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=10) as response:
            return json.load(response)

    def capture(self, mode="som", app=None, pid=None, window_id=None):
        image = self._act({"action": "capture"})["capture"]
        return CaptureResult(
            image_bytes=base64.b64decode(image["png"]),
            width=image["width"], height=image["height"], mode=mode,
        )

    def click(self, coordinate=None, x=None, y=None, **kwargs):
        if coordinate is not None:
            x, y = coordinate
        self._act({"action": "click", "x": x, "y": y})
        return ActionResult(ok=True, action="click")

    def type_text(self, text, **kwargs):
        self._act({"action": "type", "text": text})
        return ActionResult(ok=True, action="type")

    def key(self, keys, **kwargs):
        self._act({"action": "key", "keys": keys})
        return ActionResult(ok=True, action="key")

    def scroll(self, direction="down", amount=1, **kwargs):
        self._act({"action": "scroll", "direction": direction, "amount": amount})
        return ActionResult(ok=True, action="scroll")

    def drag(self, **kwargs):
        return ActionResult(ok=False, action="drag", message="Unsupported computer action")

    def list_apps(self):
        return [{"name": "Neo computer", "backend": "neo_vnc"}]

    def focus_app(self, app, raise_window=False):
        return ActionResult(ok=False, action="focus_app", message="Unsupported computer action")

    def set_value(self, value, element=None):
        return ActionResult(ok=False, action="set_value", message="Unsupported computer action")


class NeoGatewayProvider(ComputerUseProvider):
    name = "neo_vnc"

    def create_backend(self, *, permission_mode):
        return NeoGatewayBackend(permission_mode)


def register(ctx):
    ctx.register_computer_use_provider(NeoGatewayProvider())
