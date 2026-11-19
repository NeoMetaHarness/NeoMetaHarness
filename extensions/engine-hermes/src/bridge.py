"""Launch the pinned Hermes public server surfaces in Neo-owned process isolation.

Only upstream imports are used. All state, config and credentials are supplied by the
TypeScript extension, which owns the lifetime of this process.
"""
import asyncio
import argparse
import logging
logging.basicConfig(level=logging.WARNING)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("surface", choices=["dashboard", "api"])
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    if args.surface == "dashboard":
        from hermes_state import SessionDB
        db = SessionDB()
        db.close()
        from hermes_cli.web_server import app
        import uvicorn
        uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    else:
        from gateway.platforms.base import PlatformConfig
        from gateway.platforms.api_server import APIServerAdapter

        async def serve():
            # Hermes v0.23.2 gateway/run.py:1858-1882 performs MCP discovery
            # before accepting turns. APIServerAdapter alone does not run that
            # gateway startup hook, so mirror it for this isolated profile.
            from tools.mcp_tool_discovery import discover_mcp_tools
            from tools.mcp_oauth import suppress_interactive_oauth
            from tools.mcp_tool_lifecycle import shutdown_mcp_servers

            def discover():
                with suppress_interactive_oauth():
                    discover_mcp_tools()

            cfg = PlatformConfig(enabled=True, api_key=__import__("os").environ["API_SERVER_KEY"],
                                 extra={"host": "127.0.0.1", "port": args.port})
            adapter = APIServerAdapter(cfg)
            try:
                await asyncio.to_thread(discover)
                if not await adapter.connect():
                    raise RuntimeError("Hermes API server refused to start")
                # The parent closes its stdin pipe to request a clean shutdown.
                # Hermes releases its response-store SQLite handle in disconnect().
                await asyncio.to_thread(__import__("sys").stdin.buffer.read, 1)
            finally:
                try:
                    await adapter.disconnect()
                finally:
                    # Same pinned MCP lifecycle seam; also clean up failed startup.
                    await asyncio.to_thread(shutdown_mcp_servers)

        asyncio.run(serve())


if __name__ == "__main__":
    main()
