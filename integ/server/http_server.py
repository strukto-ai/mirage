# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import argparse
import asyncio

from aiohttp import web

HELLO = b"hello from http\n"
JSON_BODY = b'{"ok": true, "name": "mirage"}\n'
BINARY = bytes(range(32))


async def hello(_request: web.Request) -> web.Response:
    return web.Response(body=HELLO, content_type="text/plain")


async def json_body(_request: web.Request) -> web.Response:
    return web.Response(body=JSON_BODY, content_type="application/json")


async def binary(_request: web.Request) -> web.Response:
    return web.Response(body=BINARY, content_type="application/octet-stream")


async def missing(_request: web.Request) -> web.Response:
    return web.Response(status=404, text="not found\n")


async def boom(_request: web.Request) -> web.Response:
    return web.Response(status=500, text="server error\n")


async def redirect(_request: web.Request) -> web.Response:
    raise web.HTTPFound("/hello")


async def echo(request: web.Request) -> web.Response:
    """Report the method, a chosen header and the body back to the caller.

    Lets one case assert that -X, -H and -d actually reach the wire rather
    than only that the command exits zero.

    Args:
        request (web.Request): the incoming request.
    """
    body = await request.text()
    agent = request.headers.get("X-Mirage-Test", "-")
    lines = [
        f"method={request.method}",
        f"header={agent}",
        f"body={body}",
    ]
    return web.Response(text="\n".join(lines) + "\n",
                        content_type="text/plain")


async def form(request: web.Request) -> web.Response:
    data = await request.post()
    pairs = sorted(f"{k}={v}" for k, v in data.items())
    return web.Response(text="form " + " ".join(pairs) + "\n",
                        content_type="text/plain")


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/hello", hello)
    app.router.add_get("/data.json", json_body)
    app.router.add_get("/bytes.bin", binary)
    app.router.add_get("/missing", missing)
    app.router.add_get("/boom", boom)
    app.router.add_get("/redirect", redirect)
    app.router.add_route("*", "/echo", echo)
    app.router.add_post("/form", form)
    return app


async def serve(port: int) -> None:
    runner = web.AppRunner(build_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    assert runner.addresses
    bound = runner.addresses[0][1]
    print(f"HTTP_ENDPOINT=http://127.0.0.1:{bound}", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    asyncio.run(serve(args.port))
