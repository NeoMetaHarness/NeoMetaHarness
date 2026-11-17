"""Tiny fake OpenAI-compatible streaming server for Hermes spike testing.

Simulates an OpenAI /v1/chat/completions endpoint:
- Returns streamed text SSE chunks or JSON completion.
- Records all received requests for prompt inspection.
- When prompt contains "trigger_approval", emits a tool call requiring approval (terminal rm -rf).
- When prompt contains "trigger_computer_use", emits a computer_use tool call (click at [100, 200]).
- When tool response is present or normal prompt, emits a final text stream and completes.
"""

import http.server
import json
import socketserver
import threading
import time
from typing import Tuple

HOST = "127.0.0.1"
PORT = 18898

RECORDED_REQUESTS = []

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class FakeOpenAIHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Quiet logging

    def do_GET(self):
        if self.path.endswith("/models"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"object": "list", "data": [{"id": "fake-model", "object": "model"}]}).encode("utf-8"))
        elif self.path.endswith("/requests"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"requests": RECORDED_REQUESTS}).encode("utf-8"))
        else:
            self.send_response(200)
            self.end_headers()

    def do_POST(self):
        if "/chat/completions" in self.path:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            RECORDED_REQUESTS.append(body)

            messages = body.get("messages", [])
            stream = body.get("stream", False)

            has_tool_result = any(m.get("role") == "tool" for m in messages)
            user_text = ""
            for m in reversed(messages):
                if m.get("role") == "user":
                    content = m.get("content", "")
                    user_text = content if isinstance(content, str) else str(content)
                    break

            trigger_approval = "trigger_approval" in user_text and not has_tool_result
            trigger_cu = "trigger_computer_use" in user_text and not has_tool_result

            self.send_response(200)
            if stream:
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()

                def send_chunk(delta, finish_reason=None):
                    chunk = {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": "fake-model",
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
                    }
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                    self.wfile.flush()

                send_chunk({"role": "assistant", "content": ""})
                if trigger_approval:
                    send_chunk({
                        "content": "Initiating file removal tool call...",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_rm_danger",
                            "type": "function",
                            "function": {
                                "name": "terminal",
                                "arguments": json.dumps({"command": "rm -rf /tmp/danger_zone"}),
                            },
                        }],
                    })
                    send_chunk({}, finish_reason="tool_calls")
                elif trigger_cu:
                    send_chunk({
                        "content": "Driving desktop with computer_use click...",
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_cu_click",
                            "type": "function",
                            "function": {
                                "name": "computer_use",
                                "arguments": json.dumps({"action": "click", "coordinate": [100, 200], "capture_after": True}),
                            },
                        }],
                    })
                    send_chunk({}, finish_reason="tool_calls")
                else:
                    msg = "Turn completed following tool execution." if has_tool_result else "Standard simulated response completed."
                    send_chunk({"content": msg})
                    send_chunk({}, finish_reason="stop")

                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if trigger_approval:
                    resp = {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion",
                        "choices": [{
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "Calling tool...",
                                "tool_calls": [{
                                    "id": "call_rm_danger",
                                    "type": "function",
                                    "function": {"name": "terminal", "arguments": json.dumps({"command": "rm -rf /tmp/danger_zone"})},
                                }],
                            },
                            "finish_reason": "tool_calls",
                        }],
                    }
                elif trigger_cu:
                    resp = {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion",
                        "choices": [{
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "Calling computer_use click...",
                                "tool_calls": [{
                                    "id": "call_cu_click",
                                    "type": "function",
                                    "function": {"name": "computer_use", "arguments": json.dumps({"action": "click", "coordinate": [100, 200], "capture_after": True})},
                                }],
                            },
                            "finish_reason": "tool_calls",
                        }],
                    }
                else:
                    msg = "Turn completed following tool execution." if has_tool_result else "Standard simulated response completed."
                    resp = {
                        "id": "chatcmpl-fake",
                        "object": "chat.completion",
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": msg}, "finish_reason": "stop"}],
                    }
                self.wfile.write(json.dumps(resp).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

def start_background_server(port: int = PORT) -> Tuple[ThreadingHTTPServer, threading.Thread]:
    RECORDED_REQUESTS.clear()
    server = ThreadingHTTPServer((HOST, port), FakeOpenAIHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread

if __name__ == "__main__":
    print(f"Starting Fake OpenAI Server on http://{HOST}:{PORT} ...")
    server = ThreadingHTTPServer((HOST, PORT), FakeOpenAIHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()

