"""Minimal newline-delimited JSON-RPC 2.0 extension, run by uv without a project."""

import json
import os
import sys


def handle(method, params):
    if method == "initialize":
        return {
            "routes": [{"path": "hello"}],
            "contributions": [{"kind": "tools", "id": "sample-py.echo", "name": "Sample Python echo"}],
        }
    if method == "health":
        return {"ok": True, "pid": os.getpid()}
    if method == "route.invoke" and params.get("path") == "hello":
        return {"message": "Hello from Python"}
    if method == "shutdown":
        return {"ok": True}
    raise ValueError(f"Unknown method {method}")


for line in sys.stdin:
    try:
        request = json.loads(line)
        result = handle(request["method"], request.get("params") or {})
        reply = {"jsonrpc": "2.0", "id": request["id"], "result": result}
    except Exception as exc:
        reply = {"jsonrpc": "2.0", "id": request.get("id") if "request" in locals() else None,
                 "error": {"code": -32603, "message": str(exc)}}
    sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
    sys.stdout.flush()
    if request.get("method") == "shutdown":
        break
