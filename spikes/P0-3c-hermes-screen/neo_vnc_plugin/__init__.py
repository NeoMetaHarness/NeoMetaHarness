from pathlib import Path
from tools.computer_use.backend import (
    ActionResult,
    CaptureResult,
    ComputerUseBackend,
    ComputerUseProvider,
)

CALLS = []

class NeoVncBackend(ComputerUseBackend):
    def __init__(self, mode):
        self.mode = mode

    def start(self):
        CALLS.append(("start", self.mode))

    def stop(self):
        CALLS.append(("stop", None))

    def is_available(self):
        return True

    def capture(self, mode="som", app=None, pid=None, window_id=None):
        CALLS.append(("capture", {"mode": mode, "app": app, "pid": pid, "window_id": window_id}))
        # 1x1 transparent PNG
        dummy_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa76\x814\x00\x00\x00\x00IEND\xaeB`\x82"
        return CaptureResult(
            image_bytes=dummy_png,
            width=1024,
            height=768,
            mode=mode,
        )

    def click(self, **kw):
        CALLS.append(("click", kw))
        return ActionResult(ok=True, action="click", message="Clicked coordinate on Neo VNC desktop")

    def drag(self, **kw):
        CALLS.append(("drag", kw))
        return ActionResult(ok=True, action="drag")

    def scroll(self, **kw):
        CALLS.append(("scroll", kw))
        return ActionResult(ok=True, action="scroll")

    def type_text(self, text, **kw):
        CALLS.append(("type", text))
        return ActionResult(ok=True, action="type")

    def key(self, keys, **kw):
        CALLS.append(("key", keys))
        return ActionResult(ok=True, action="key")

    def list_apps(self):
        return [{"name": "Neo VNC Desktop", "backend": "neo_vnc"}]

    def focus_app(self, app, raise_window=False):
        return ActionResult(ok=True, action="focus_app")

    def set_value(self, value, element=None):
        return ActionResult(ok=True, action="set_value")

class NeoVncProvider(ComputerUseProvider):
    name = "neo_vnc"

    def create_backend(self, *, permission_mode):
        return NeoVncBackend(permission_mode)

def register(ctx):
    ctx.register_computer_use_provider(NeoVncProvider())
