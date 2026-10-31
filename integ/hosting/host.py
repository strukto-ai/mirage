import asyncio
import socket
from contextlib import asynccontextmanager

import uvicorn
from fastapi.responses import PlainTextResponse

from mirage.server.app import build_app
from mirage.server.auth.config import AuthConfig, AuthMode


async def main() -> None:
    app = build_app(
        auth_config=AuthConfig(mode=AuthMode.LOCAL), idle_grace_seconds=60
    )
    gates: dict[str, asyncio.Event] = {}
    original_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(instance):
        async with original_lifespan(instance):
            yield
        print("STOPPED", flush=True)

    app.router.lifespan_context = lifespan

    @app.api_route("/__integ/hold/{key}", methods=["GET", "POST"])
    async def hold(key: str) -> PlainTextResponse:
        gate = gates.setdefault(key, asyncio.Event())
        await gate.wait()
        return PlainTextResponse("released\n")

    @app.get("/__integ/entered/{key}")
    async def entered(key: str) -> dict[str, bool]:
        return {"entered": key in gates}

    # The lines a workspace's sessions have queued, which have not started.
    @app.get("/__integ/pending/{wid}")
    async def pending(wid: str) -> dict[str, list[str]]:
        jobs = app.state.jobs.list(wid)
        return {"pending": [j.command for j in jobs if j.status == "pending"]}

    @app.post("/__integ/release/{key}")
    async def release(key: str) -> dict[str, bool]:
        gates.setdefault(key, asyncio.Event()).set()
        return {"released": True}

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        server = uvicorn.Server(
            uvicorn.Config(app, log_level="error", timeout_graceful_shutdown=2)
        )
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        while not server.started:
            if serving.done():
                await serving
                raise RuntimeError("HTTP server did not start")
            await asyncio.sleep(0.01)
        print(f"READY http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
        await serving


if __name__ == "__main__":
    asyncio.run(main())
