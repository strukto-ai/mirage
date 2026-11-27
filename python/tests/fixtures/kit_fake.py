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
import base64
import inspect
import json
import select
import sqlite3
import subprocess
import tempfile
import threading
import uuid
from collections.abc import Awaitable, Callable, Coroutine, Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, TypeVar
from urllib.parse import parse_qsl

import aiohttp

INTEG = Path(__file__).resolve().parents[3] / "integ"
START_SECONDS = 20
STOP_SECONDS = 5
SETUP_HEADER = "X-Kit-Setup"
T = TypeVar("T")


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


class LoopThread:
    """An event loop on a thread of its own, for a caller that cannot await.

    A synchronous callable handed to the code under test (a fetch count, a
    rewrite) runs a coroutine here and blocks until it ends; the fake it
    reaches is another process, so the caller's own loop waiting meanwhile
    holds nothing up.
    """

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever)
        self.thread.start()

    def run(self, call: Coroutine[Any, Any, T]) -> T:
        """Run ``call`` on this thread's loop and return what it returns.

        Args:
            call (Coroutine[Any, Any, T]): the coroutine to run.
        """
        return asyncio.run_coroutine_threadsafe(call, self.loop).result()

    def close(self) -> None:
        """Stop the loop and its thread."""
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join()
        self.loop.close()


class KitRun:
    """One run of a kit fake: a world of its own, reached under ``url``.

    Every request it sends is marked as the test's own setup, so the fake
    lists, holds and faults only the requests of the code under test.

    Args:
        origin (str): the fake's origin, as :func:`serve` yields it.
        headers (dict[str, str]): what selects the tenant, as the client
            under test sends it.
    """

    def __init__(self, origin: str, headers: dict[str, str]) -> None:
        self.name = uuid.uuid4().hex
        self.origin = origin
        self.url = f"{origin}/_run/{self.name}"
        self.http = aiohttp.ClientSession(
            headers={**headers, SETUP_HEADER: "1"}
        )
        self.changes: list[asyncio.Task[None]] = []
        self.failed: list[BaseException] = []

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
            dict(parse_qsl(r["query"], keep_blank_values=True))
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
        path: str | None = None,
        query: str | None = None,
    ) -> None:
        """Answer the next ``times`` requests to ``route`` with ``status``.

        Args:
            method (str): the HTTP method.
            route (str): the route as the fake declares it.
            status (int): the status to answer.
            body (Any): the JSON body to answer, bytes to send as written;
                the kit's own if None.
            times (int): how many requests it answers.
            path (str | None): the one request path it answers; any the
                route serves if None.
            query (str | None): the one query string it answers, ``""``
                for none; any if None.
        """
        plan: dict[str, Any] = {
            "method": method,
            "route": route,
            "status": status,
            "times": times,
        }
        if path is not None:
            plan["path"] = path
        if query is not None:
            plan["query"] = query
        if isinstance(body, bytes):
            plan["text"] = body.decode()
        elif body is not None:
            plan["body"] = body
        await self.call("POST", "/_kit/faults", json={"plans": [plan]})

    async def clear_answers(self) -> None:
        """Disarm every answer :meth:`answer_next` armed."""
        await self.call("DELETE", "/_kit/faults")

    async def before_next(
        self,
        routes: list[tuple[str, str]],
        change: Callable[[], Awaitable[None] | None],
        status: int | None = None,
        query: str | None = None,
    ) -> None:
        """Hold the next request to one of ``routes`` and run ``change``
        while it waits, then serve it, or answer it with ``status``.

        It is another client's write landing between the lookup the code
        under test made and the request it acts on, made on purpose.

        Args:
            routes (list[tuple[str, str]]): ``(method, route)`` pairs, each
                route as the fake declares it.
            change (Callable[[], Awaitable[None] | None]): what happens
                while the request waits.
            status (int | None): the status to answer it with instead of
                serving it.
            query (str | None): the one query string a held request is
                asked with, ``""`` for none; any if None.
        """
        body: dict[str, Any] = {"routes": [list(r) for r in routes]}
        if query is not None:
            body["query"] = query
        armed = await self.call("POST", "/_kit/holds", json=body)
        hold = f"/_kit/holds/{armed['hold']}"
        self.changes.append(
            asyncio.create_task(self._change_when_held(hold, change, status))
        )

    async def _change_when_held(
        self,
        hold: str,
        change: Callable[[], Awaitable[None] | None],
        status: int | None,
    ) -> None:
        async with self.http.get(
            self.url + hold, timeout=aiohttp.ClientTimeout(total=None)
        ) as resp:
            if resp.status == 404:
                return
            assert resp.status == 200, await resp.text()
        release: dict[str, Any] = {} if status is None else {"status": status}
        try:
            done = change()
            if inspect.isawaitable(done):
                await done
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            # Kept before the release is awaited: the held request may end
            # the test first, and close() cancels that await.
            self.failed.append(exc)
            release = {"status": 500}
            raise
        finally:
            if release:
                await self.call("DELETE", hold, json=release)
            else:
                await self.call("DELETE", hold)

    async def execute(self, sql: str, *params: Any) -> None:
        """Run one SQL statement on the run's database, for a stored state
        no vendor request makes.

        The run is loaded back from the result, which starts its kit state
        afresh: a recording of its requests stops.

        Args:
            sql (str): the statement.
            *params (Any): its parameters.
        """
        ops = f"/_kit/runs/{self.name}"
        snapshot = await self.call("GET", f"{ops}/snapshot")
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "run.db"
            db.write_bytes(base64.b64decode(snapshot["db"]))
            with closing(sqlite3.connect(db)) as conn:
                conn.execute(sql, params)
                conn.commit()
            snapshot["db"] = base64.b64encode(db.read_bytes()).decode()
        await self.call("POST", f"{ops}/load", json=snapshot)

    async def close(self) -> None:
        """Drop the run and what it holds, and raise what a change raised."""
        for task in self.changes:
            if not task.done():
                task.cancel()
        done = await asyncio.gather(*self.changes, return_exceptions=True)
        async with self.http.delete(
            f"{self.origin}/_kit/runs/{self.name}"
        ) as resp:
            assert resp.status == 204, await resp.text()
        await self.http.close()
        if self.failed:
            raise self.failed[0]
        for result in done:
            if isinstance(result, BaseException) and not isinstance(
                result, asyncio.CancelledError
            ):
                raise result
