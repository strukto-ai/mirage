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

import asyncio

from aiohttp import web

MEMORIES = [
    {
        "id": "mem-alpha",
        "memory": "Quarterly planning happens on Tuesday.",
        "metadata": {
            "topic": "planning"
        },
        "created_at": "2026-01-01T10:00:00Z",
        "updated_at": "2026-01-03T10:00:00Z",
    },
    {
        "id": "mem-beta",
        "memory": "The user prefers dark mode.",
        "metadata": {
            "topic": "preferences"
        },
        "created_at": "2026-01-02T10:00:00Z",
        "updated_at": "2026-01-02T10:00:00Z",
    },
    {
        "id": "mem-gamma",
        "memory": "The next trip is to Seattle.",
        "metadata": {
            "topic": "travel"
        },
        "created_at": "2026-01-03T10:00:00Z",
        "updated_at": "2026-01-04T10:00:00Z",
    },
]

SCORES = {
    "mem-alpha": 0.97,
    "mem-beta": 0.82,
    "mem-gamma": 0.88,
}


def _scope_matches(filters: dict) -> bool:
    return filters.get("user_id") == "integ-user"


async def handle(request: web.Request) -> web.Response:
    path = request.path.rstrip("/")
    if path == "/v1/ping" and request.method == "GET":
        return web.json_response({
            "user_email": "integ@example.com",
            "org_id": "org-integ",
            "project_id": "project-integ",
        })
    if path == "/v3/memories" and request.method == "POST":
        body = await request.json()
        if not _scope_matches(body.get("filters", {})):
            return web.json_response({
                "count": 0,
                "next": None,
                "previous": None,
                "results": [],
            })
        page = int(request.query.get("page", "1"))
        page_size = int(request.query.get("page_size", "100"))
        start = (page - 1) * page_size
        batch = MEMORIES[start:start + page_size]
        next_url = (f"{request.scheme}://{request.host}/v3/memories/"
                    f"?page={page + 1}&page_size={page_size}" if start +
                    page_size < len(MEMORIES) else None)
        return web.json_response({
            "count": len(MEMORIES),
            "next": next_url,
            "previous": None,
            "results": batch,
        })
    if path == "/v3/memories/search" and request.method == "POST":
        body = await request.json()
        if not _scope_matches(body.get("filters", {})):
            return web.json_response({"results": []})
        query = str(body.get("query", "")).lower()
        threshold = float(body.get("threshold", 0))
        top_k = int(body.get("top_k", 10))
        results = []
        for memory in MEMORIES:
            score = SCORES[memory["id"]]
            text = f"{memory['memory']} {memory['metadata']['topic']}".lower()
            if query not in text or score < threshold:
                continue
            results.append({**memory, "score": score})
        results.sort(key=lambda item: item["score"], reverse=True)
        return web.json_response({"results": results[:top_k]})
    prefix = "/v1/memories/"
    if path.startswith(prefix) and request.method == "GET":
        memory_id = path[len(prefix):]
        for memory in MEMORIES:
            if memory["id"] == memory_id:
                return web.json_response(memory)
        return web.json_response({"detail": "Memory not found"}, status=404)
    return web.json_response({"detail": "Not found"}, status=404)


async def start_fake_mem0() -> tuple[str, web.AppRunner]:
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return f"http://127.0.0.1:{port}", runner


async def serve_forever() -> None:
    endpoint, runner = await start_fake_mem0()
    print(endpoint, flush=True)
    try:
        await asyncio.Future()
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(serve_forever())
