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
            cfg = PlatformConfig(enabled=True, api_key=__import__("os").environ["API_SERVER_KEY"],
                                 extra={"host": "127.0.0.1", "port": args.port})
            adapter = APIServerAdapter(cfg)
            if not await adapter.connect():
                raise RuntimeError("Hermes API server refused to start")
            try:
                await asyncio.Event().wait()
            finally:
                await adapter.disconnect()

        asyncio.run(serve())


if __name__ == "__main__":
    main()
