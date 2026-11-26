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

import json
import select
import subprocess
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl

import aiohttp

INTEG = Path(__file__).resolve().parents[3] / "integ"
START_SECONDS = 20
STOP_SECONDS = 5


@contextmanager
def serve(service: str) -> Iterator[str]:
    """Run ``integ/server/<service>/main.ts`` and yield its origin.

    The fake is the one the integ battery runs against, started on a port
    of its own. It needs ``pnpm install`` and ``pnpm run prisma:clients``
    in ``integ/``.

    Args:
        service (str): directory under ``integ/server/`` holding main.ts.
    """
    process = subprocess.Popen(
        [
            str(INTEG / "node_modules" / ".bin" / "tsx"),
            str(INTEG / "server" / service / "main.ts"),
            "--port",
            "0",
        ],
        cwd=INTEG,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    try:
        ready, _, _ = select.select([process.stdout], [], [], START_SECONDS)
        line = process.stdout.readline() if ready else ""
        name, _, origin = line.strip().partition("=")
        if name != f"{service.upper().replace('-', '_')}_URL" or not origin:
            raise RuntimeError(
                f"{service} fake did not start; run pnpm install and "
                "pnpm run prisma:clients in integ/"
            )
        yield origin.rstrip("/")
    finally:
        process.terminate()
        try:
            process.wait(STOP_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


class KitRun:
    """One run of a kit fake: a world of its own, reached under ``url``.

    Args:
        origin (str): the fake's origin, as :func:`serve` yields it.
        headers (dict[str, str]): what selects the tenant, as the client
            under test sends it.
    """

    def __init__(self, origin: str, headers: dict[str, str]) -> None:
        self.name = uuid.uuid4().hex
        self.origin = origin
        self.url = f"{origin}/_run/{self.name}"
        self.http = aiohttp.ClientSession(headers=headers)

    async def call(self, method: str, path: str, **request: Any) -> Any:
        """One request to the fake, answered as JSON; None for no body.

        Args:
            method (str): the HTTP method.
            path (str): the path under the run.
            **request (Any): what ``aiohttp`` takes for the request.
        """
        async with self.http.request(
            method, self.url + path, **request
        ) as resp:
            text = await resp.text()
            assert resp.status < 300, text
            return json.loads(text) if text else None

    async def read(
        self, path: str, method: str = "GET", **request: Any
    ) -> bytes:
        """One request to the fake, answered as bytes, redirects followed.

        Args:
            path (str): the path under the run.
            method (str): the HTTP method.
            **request (Any): what ``aiohttp`` takes for the request.
        """
        async with self.http.request(
            method, self.url + path, **request
        ) as resp:
            body = await resp.read()
            assert resp.status < 300, body
            return body

    async def record_requests(self, *headers: str) -> None:
        """Start listing the tenant's requests, emptying an earlier list.

        Args:
            *headers (str): the headers to keep from each request.
        """
        await self.call(
            "POST", "/_kit/requests", json={"headers": list(headers)}
        )

    async def requests(self) -> list[str]:
        """The requests made since recording started, as ``METHOD path``
        and then ``name=value`` for each kept header a request carried."""
        listed = await self.call("GET", "/_kit/requests")
        return [
            " ".join(
                [
                    r["method"],
                    r["path"],
                    *(f"{k}={v}" for k, v in r["headers"].items()),
                ]
            )
            for r in listed["requests"]
        ]

    async def params(self, method: str, route: str) -> list[dict[str, str]]:
        """The query of each listed request to ``route``, in order.

        Args:
            method (str): the HTTP method.
            route (str): the route as the fake declares it.
        """
        listed = await self.call("GET", "/_kit/requests")
        return [
            dict(parse_qsl(r["query"]))
            for r in listed["requests"]
            if r["method"] == method and r["route"] == route
        ]

    async def headers(self, method: str, route: str) -> list[dict[str, str]]:
        """The kept headers of each listed request to ``route``, in order.

        Args:
            method (str): the HTTP method.
            route (str): the route as the fake declares it.
        """
        listed = await self.call("GET", "/_kit/requests")
        return [
            r["headers"]
            for r in listed["requests"]
            if r["method"] == method and r["route"] == route
        ]

    async def bodies(self, method: str, route: str) -> list[Any]:
        """The JSON body of each listed request to ``route``, in order.

        Args:
            method (str): the HTTP method.
            route (str): the route as the fake declares it.
        """
        listed = await self.call("GET", "/_kit/requests")
        return [
            r["body"]
            for r in listed["requests"]
            if r["method"] == method and r["route"] == route
        ]

    async def answer_next(
        self,
        method: str,
        route: str,
        status: int,
        body: Any = None,
        times: int = 1,
    ) -> None:
        """Answer the next ``times`` requests to ``route`` with ``status``.

        Args:
            method (str): the HTTP method.
            route (str): the route as the fake declares it.
            status (int): the status to answer.
            body (Any): the JSON body to answer; the kit's own if None.
            times (int): how many requests it answers.
        """
        plan = {
            "method": method,
            "route": route,
            "status": status,
            "times": times,
        }
        if body is not None:
            plan["body"] = body
        await self.call("POST", "/_kit/faults", json={"plans": [plan]})

    async def close(self) -> None:
        """Drop the run and what it holds."""
        async with self.http.delete(
            f"{self.origin}/_kit/runs/{self.name}"
        ) as resp:
            assert resp.status == 204, await resp.text()
        await self.http.close()
