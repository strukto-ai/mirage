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
import json
import logging
import os
import signal
import threading
import time
from collections.abc import AsyncIterator, Callable, Sequence
from pathlib import Path
from types import FrameType
from typing import Any, cast
from urllib.parse import parse_qs, quote

import h11
import httpx
from starlette.types import Message, Receive, Scope, Send
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
from websockets.asyncio.client import unix_connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from mirage.server.host_validation import HostHeaderMiddleware
from mirage.server.multipart import MAX_REQUEST_PART
from mirage.server.rate_limit import COUNTED_HEADER
from mirage.server.workers.constants import AUTH_PROBE, UNAVAILABLE
from mirage.server.workers.http import (
    answered,
    framed,
    headers_for,
    passable,
    path_parts,
    send_answer,
    send_json,
    target,
)
from mirage.server.workers.peek import chunks, id_of, peek
from mirage.server.workers.pool import WorkerPool
from mirage.server.workers.types import Answer
from mirage.server.workers.worker import Worker

logger = logging.getLogger(__name__)


# What FastAPI reads as false in a query flag.
_FALSE = frozenset({"0", "f", "false", "n", "no", "off"})


class WorkerProxy:
    """The daemon's server when it runs workers: an ASGI app that sends
    each request to the worker holding its workspace and answers health,
    readiness and lists over all of them. Mirrors TypeScript's
    ``WorkerProxy``.

    Args:
        pool (WorkerPool): the workers, started with the app.
        max_workspaces (int | None): the most workspaces the workers hold
            together; None for no cap.
        idle_grace_seconds (float): how long the workers may hold no
            workspace before the daemon exits.
        exit (Callable[[], None]): stops the daemon: after idling, or on a
            shutdown a worker let through.
        pid_file (Path | None): where the daemon's pid is written while
            it runs; None writes none.
    """

    def __init__(
        self,
        pool: WorkerPool,
        max_workspaces: int | None,
        idle_grace_seconds: float,
        exit: Callable[[], None],
        pid_file: Path | None = None,
    ) -> None:
        self.pool = pool
        self.max_workspaces = max_workspaces
        self.idle_grace_seconds = idle_grace_seconds
        self.exit = exit
        self.pid_file = pid_file
        self.draining = False
        self._idle: asyncio.TimerHandle | None = None
        self._started_at = time.time()
        self._closing: asyncio.Future[None] | None = None
        pool.on_lost = self._idle_check

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] == "lifespan":
            await self._lifespan(receive, send)
        elif scope["type"] == "websocket":
            await self._websocket(scope, receive, send)
        else:
            await self._handle(scope, receive, send)

    async def _lifespan(self, receive: Receive, send: Send) -> None:
        wrapped: dict[
            signal.Signals, Callable[[int, FrameType | None], Any]
        ] = {}
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                try:
                    await self.pool.start()
                except Exception as exc:
                    await self.pool.stop()
                    await send(
                        {
                            "type": "lifespan.startup.failed",
                            "message": str(exc),
                        }
                    )
                    return
                if self.pid_file is not None:
                    self.pid_file.parent.mkdir(parents=True, exist_ok=True)
                    self.pid_file.write_text(str(os.getpid()))
                wrapped = self._close_on_signals()
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                for signum, stop in wrapped.items():
                    signal.signal(signum, stop)
                await self.close()
                if self.pid_file is not None:
                    self.pid_file.unlink(missing_ok=True)
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def close(self) -> None:
        """Refuse new work and stop the workers, once."""
        self.draining = True
        self._cancel_idle()
        if self._closing is None:
            self._closing = asyncio.ensure_future(self.pool.stop())
        await self._closing

    def _close_on_signals(
        self,
    ) -> dict[signal.Signals, Callable[[int, FrameType | None], Any]]:
        """Have SIGTERM and SIGINT start stopping the workers before the
        server's own handlers run: the server then waits for the requests
        they answer, which end as the workers drain, within
        ``graceful_timeout``. Only the main thread may set a handler.

        Returns:
            dict[signal.Signals, Callable[[int, FrameType | None], Any]]:
                the handlers it wrapped, to put back as the app stops.
        """
        if threading.current_thread() is not threading.main_thread():
            return {}
        loop = asyncio.get_running_loop()
        wrapped = {}
        for signum in (signal.SIGTERM, signal.SIGINT):
            stop = signal.getsignal(signum)
            if not callable(stop):
                continue
            wrapped[signum] = stop

            def closing(
                number: int,
                frame: FrameType | None,
                stop: Callable[[int, FrameType | None], Any] = stop,
            ) -> None:
                loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(self.close())
                )
                stop(number, frame)

            signal.signal(signum, closing)
        return wrapped

    async def _handle(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        pool = self.pool
        first = pool.first()
        if first is None:
            return await send_answer(send, UNAVAILABLE)
        parts = path_parts(scope["path"])
        method = scope["method"]
        if parts[:1] != ["v1"]:
            return await self._pass(first, scope, receive, send)
        resource = parts[1] if len(parts) > 1 else None
        workspace_id = parts[2] if len(parts) > 2 else None
        action = parts[3] if len(parts) > 3 else None
        if resource == "health" and len(parts) == 2 and method == "GET":
            return await send_json(
                send,
                200,
                {
                    "status": "ok",
                    "workspaces": pool.count(),
                    "uptime_s": round(time.time() - self._started_at, 3),
                    "workers": sum(1 for w in pool.workers if not w.dead),
                },
            )
        if resource == "ready" and len(parts) == 2 and method == "GET":
            status = (
                "shutting_down"
                if self.draining
                else "ready"
                if self._has_room(1)
                else "full"
            )
            return await send_json(
                send, 200 if status == "ready" else 503, {"status": status}
            )
        if resource == "shutdown" and len(parts) == 2 and method == "POST":
            # A worker answers whether the caller may stop the daemon.
            answer = await self._fetch(first, scope, b"", receive)
            if answer.status != 200:
                return await send_answer(send, answer)
            await send_json(
                send, 200, {"status": "shutting_down", "pid": os.getpid()}
            )
            self.exit()
            return
        if resource != "workspaces":
            return await self._pass(first, scope, receive, send)
        if workspace_id is None:
            if method == "GET":
                return await self._gather(scope, send)
            # An explain builds nothing, so it holds no slot.
            query = parse_qs(scope.get("query_string", b"").decode())
            explain = query.get("explain", ["false"])[-1].lower()
            if method == "POST" and explain not in _FALSE:
                return await self._pass(first, scope, receive, send)
            if method == "POST":
                return await self._create(scope, receive, send, None)
            return await self._pass(first, scope, receive, send)
        if workspace_id == "load" and len(parts) == 3 and method == "POST":
            return await self._create(scope, receive, send, None)
        home = pool.home(workspace_id)
        if home is None or home.dead:
            return await self._pass(first, scope, receive, send)
        if action == "clone" and len(parts) == 4 and method == "POST":
            return await self._create(scope, receive, send, home)
        deletes = action is None and method == "DELETE"
        closes = action == "close" and len(parts) == 4 and method == "POST"
        if deletes or closes:
            answer = await self._fetch(home, scope, b"", receive)
            # A close or delete that fails in the worker may still have
            # removed the workspace. A refusal (4xx) leaves it, and may hide
            # it from this caller, so only a 5xx is checked.
            gone = answer.status < 300 or (
                answer.status >= 500
                and not await self._holds(home, scope, workspace_id)
            )
            if gone:
                if deletes:
                    pool.forget(workspace_id)
                else:
                    pool.release(workspace_id)
                self._idle_check()
            return await send_answer(send, answer)
        return await self._pass(home, scope, receive, send)

    async def _create(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
        source: Worker | None,
    ) -> None:
        """A create, load or clone: to the worker holding or creating the
        id it names, else to ``source``'s for a clone, else to a worker at
        random."""
        pool = self.pool
        if self.draining:
            return await send_json(
                send, 503, {"detail": "server is shutting down"}
            )
        reserved = False
        try:
            refused = await self._refused(scope, source or pool.first())
            if refused is not None:
                return await send_answer(send, refused)
            peeked = await peek(scope, receive)
            if peeked.lost:
                return await send_json(
                    send,
                    413,
                    {
                        "detail": "the workspace id must come in the body's "
                        f"first {MAX_REQUEST_PART} bytes"
                    },
                )
            if peeked.twice:
                return await send_json(
                    send,
                    400,
                    {
                        "detail": "multipart body has more than one "
                        "'request' part"
                    },
                )
            named = peeked.id
            home = pool.home(named) if named is not None else None
            live = home is not None and named in home.live
            # A retry of a live id goes to its worker even when full, but
            # holds a slot too: the worker may close that id first and
            # build it again.
            if not live and not self._has_room(1):
                return await send_json(
                    send,
                    503,
                    {
                        "detail": "server is at max_workspaces "
                        f"({self.max_workspaces})"
                    },
                )
            building = pool.building(named) if named is not None else None
            if source is not None and building not in (None, source):
                return await send_json(
                    send,
                    409,
                    {"detail": f"workspace id already exists: {named}"},
                )
            # A clone builds on its source's worker, so an id another
            # worker holds, even closed, stays there: a create reaches it.
            if (
                source is not None
                and home is not None
                and not home.dead
                and home is not source
            ):
                detail = (
                    f"workspace id already exists: {named}"
                    if live
                    else "workspace id was used on another worker; "
                    f"create it there instead: {named}"
                )
                return await send_json(send, 409, {"detail": detail})
            alive = home if home is not None and not home.dead else None
            worker = source or alive or pool.random()
            if worker is None:
                return await send_answer(send, UNAVAILABLE)
            # Nothing is awaited between the check above and here, so
            # creates racing each other cannot pass max_workspaces.
            pool.reserved += 1
            reserved = True
            settle = pool.claim(named, worker) if named is not None else None
            self._cancel_idle()
            try:
                answer = await self._fetch(
                    worker,
                    scope,
                    peeked.head,
                    receive if peeked.more else None,
                    counted=True,
                )
                if answer.status == 201:
                    made = id_of(answer.body)
                    if made is not None:
                        pool.adopt(made, worker)
                await send_answer(send, answer)
            finally:
                if settle is not None:
                    settle()
        finally:
            if reserved:
                pool.reserved -= 1
            self._idle_check()

    async def _gather(self, scope: Scope, send: Send) -> None:
        """The workspace list: every worker's, merged by creation time."""
        running = [w for w in self.pool.workers if not w.dead]
        answers = await asyncio.gather(
            *(self._fetch(w, scope, b"") for w in running)
        )
        for answer in answers:
            if answer.status != 200:
                return await send_answer(send, answer)
        items = [item for a in answers for item in json.loads(a.body)]
        items.sort(key=lambda item: float(item.get("created_at") or 0))
        await send_json(send, 200, items)

    async def _refused(
        self, scope: Scope, worker: Worker | None
    ) -> Answer | None:
        """A worker's refusal of the caller, asked before a body is read:
        None when the caller may go on."""
        if worker is None:
            return None
        headers = [
            (k, v)
            for k, v in headers_for(scope)
            if k not in ("content-length", "content-type")
        ]
        try:
            response = await worker.http().get(AUTH_PROBE, headers=headers)
        except httpx.TransportError as exc:
            logger.debug(
                "mirage: worker %d did not answer: %s", worker.index, exc
            )
            return UNAVAILABLE
        if response.status_code < 300:
            return None
        return answered(response)

    async def _holds(
        self, worker: Worker, scope: Scope, workspace_id: str
    ) -> bool:
        """Whether ``worker`` still holds workspace ``workspace_id``."""
        headers = [
            (k, v)
            for k, v in headers_for(scope)
            if k not in ("content-length", "content-type")
        ]
        headers.append((COUNTED_HEADER, self.pool.token))
        try:
            response = await worker.http().get(
                f"/v1/workspaces/{quote(workspace_id, safe='')}",
                headers=headers,
            )
        except httpx.TransportError as exc:
            logger.debug(
                "mirage: worker %d did not answer: %s", worker.index, exc
            )
            return True
        return response.status_code != 404

    def _has_room(self, extra: int) -> bool:
        """Whether ``extra`` more workspaces fit under ``max_workspaces``."""
        cap = self.max_workspaces
        return cap is None or self.pool.held() + extra <= cap

    def _request(
        self, worker: Worker, scope: Scope, content: Any, counted: bool
    ) -> httpx.Request:
        headers = headers_for(scope)
        if counted:
            # The caller check counted it already against the rate limits.
            headers.append((COUNTED_HEADER, self.pool.token))
        return worker.http().build_request(
            scope["method"], target(scope), headers=headers, content=content
        )

    async def _pass(
        self, worker: Worker, scope: Scope, receive: Receive, send: Send
    ) -> None:
        """Pass a request through to ``worker``, streaming both ways at
        once, so a shell's output comes while its stdin still uploads. A
        client gone before the answer ends stops the worker's side too."""
        try:
            reader, writer = await asyncio.open_unix_connection(worker.socket)
        except OSError as exc:
            logger.debug(
                "mirage: worker %d did not answer: %s", worker.index, exc
            )
            return await send_answer(send, UNAVAILABLE)
        connection = h11.Connection(h11.CLIENT)
        writer.write(
            connection.send(
                h11.Request(
                    method=scope["method"],
                    target=target(scope),
                    headers=framed(scope, worker.host),
                )
            )
        )
        sent = asyncio.Event()

        async def upload() -> None:
            try:
                async for chunk in chunks(receive):
                    if chunk:
                        writer.write(connection.send(h11.Data(data=chunk)))
                        await writer.drain()
                writer.write(connection.send(h11.EndOfMessage()))
                await writer.drain()
            except (OSError, h11.LocalProtocolError) as exc:
                # The worker answered without taking the whole body.
                logger.debug("mirage: a request body was cut: %s", exc)
            finally:
                sent.set()

        async def answer() -> None:
            started = False
            try:
                while True:
                    event = connection.next_event()
                    if event is h11.NEED_DATA:
                        connection.receive_data(await reader.read(65536))
                    elif isinstance(event, h11.Response):
                        await send(
                            {
                                "type": "http.response.start",
                                "status": event.status_code,
                                "headers": passable(list(event.headers)),
                            }
                        )
                        started = True
                    elif isinstance(event, h11.Data):
                        await send(
                            {
                                "type": "http.response.body",
                                "body": bytes(event.data),
                                "more_body": True,
                            }
                        )
                    elif isinstance(event, h11.EndOfMessage):
                        await send({"type": "http.response.body", "body": b""})
                        return
                    elif isinstance(event, h11.ConnectionClosed):
                        raise ConnectionResetError("the worker closed")
            except (OSError, h11.RemoteProtocolError) as exc:
                logger.debug(
                    "mirage: worker %d did not answer: %s", worker.index, exc
                )
                if not started:
                    await send_answer(send, UNAVAILABLE)

        async def gone() -> None:
            await sent.wait()
            while True:
                message: Message = await receive()
                if message["type"] == "http.disconnect":
                    return

        uploading = asyncio.create_task(upload())
        answering = asyncio.create_task(answer())
        watching = asyncio.create_task(gone())
        try:
            done, _ = await asyncio.wait(
                [answering, watching], return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            uploading.cancel()
            watching.cancel()
            if not answering.done():
                answering.cancel()
            writer.close()
        if answering in done:
            await answering

    async def _fetch(
        self,
        worker: Worker,
        scope: Scope,
        body: bytes,
        rest: Receive | None = None,
        counted: bool = False,
    ) -> Answer:
        """Send ``body``, and the rest of the request from ``rest``, and
        read the whole answer."""

        async def then(rest: Receive) -> AsyncIterator[bytes]:
            if body:
                yield body
            async for chunk in chunks(rest):
                yield chunk

        content: Any = body if rest is None else then(rest)
        try:
            response = await worker.http().send(
                self._request(worker, scope, content, counted)
            )
        except httpx.TransportError as exc:
            logger.debug(
                "mirage: worker %d did not answer: %s", worker.index, exc
            )
            return UNAVAILABLE
        return answered(response)

    async def _websocket(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        """A WebSocket: its messages, to and from the workspace's worker."""
        parts = path_parts(scope["path"])
        home = (
            self.pool.home(parts[2])
            if len(parts) > 2 and parts[1] == "workspaces"
            else None
        )
        worker = (
            home if home is not None and not home.dead else self.pool.first()
        )
        if worker is None:
            await send({"type": "websocket.close", "code": 1011})
            return
        headers = headers_for(scope)
        host = next((v for k, v in headers if k == "host"), worker.host)
        query = scope.get("query_string", b"").decode()
        path = (scope.get("raw_path") or scope["path"].encode()).decode(
            "latin-1"
        )
        uri = f"ws://{host}{path}" + ("?" + query if query else "")
        kept = [
            (k, v)
            for k, v in headers
            if not k.startswith("sec-websocket-") and k != "host"
        ]
        await receive()
        try:
            upstream = await unix_connect(
                worker.socket,
                uri,
                additional_headers=kept,
                subprotocols=scope.get("subprotocols") or None,
                max_size=None,
            )
        except InvalidStatus as exc:
            # The worker's refusal, as it sent it, where the server can.
            refusal = exc.response
            if "websocket.http.response" in scope.get("extensions", {}):
                raw = [
                    (k.encode("latin-1"), v.encode("latin-1"))
                    for k, v in refusal.headers.raw_items()
                ]
                await send(
                    {
                        "type": "websocket.http.response.start",
                        "status": refusal.status_code,
                        "headers": passable(raw),
                    }
                )
                await send(
                    {
                        "type": "websocket.http.response.body",
                        "body": refusal.body or b"",
                    }
                )
            else:
                await send({"type": "websocket.close", "code": 1008})
            return
        except Exception as exc:
            logger.debug(
                "mirage: worker %d refused a WebSocket: %s", worker.index, exc
            )
            await send({"type": "websocket.close", "code": 1011})
            return
        await send(
            {"type": "websocket.accept", "subprotocol": upstream.subprotocol}
        )

        async def down() -> None:
            try:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await send(
                            {"type": "websocket.send", "bytes": message}
                        )
                    else:
                        await send({"type": "websocket.send", "text": message})
            except ConnectionClosed as exc:
                logger.debug("mirage: a worker's WebSocket closed: %s", exc)
            # The worker's close, as it sent it: 1005 says none came, 1006
            # and 1015 that the connection failed, and none can be sent.
            code = upstream.close_code
            if code is None or code == 1005:
                code = 1000
            elif code in (1006, 1015):
                code = 1011
            await send(
                {
                    "type": "websocket.close",
                    "code": code,
                    "reason": upstream.close_reason or "",
                }
            )

        async def up() -> None:
            while True:
                message = await receive()
                if message["type"] == "websocket.disconnect":
                    await upstream.close()
                    return
                if message.get("bytes") is not None:
                    await upstream.send(message["bytes"])
                elif message.get("text") is not None:
                    await upstream.send(message["text"])

        tasks = [asyncio.create_task(down()), asyncio.create_task(up())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await upstream.close()

    def _idle_check(self) -> None:
        """Exit once no worker holds a workspace for
        ``idle_grace_seconds``."""
        if self.draining or self.pool.held() > 0:
            return
        if self.idle_grace_seconds <= 0:
            self.exit()
            return
        if self._idle is not None:
            return
        self._idle = asyncio.get_running_loop().call_later(
            self.idle_grace_seconds, self._idle_fired
        )

    def _idle_fired(self) -> None:
        self._idle = None
        if not self.draining and self.pool.held() == 0:
            self.exit()

    def _cancel_idle(self) -> None:
        if self._idle is not None:
            self._idle.cancel()
            self._idle = None


def build_worker_proxy(
    pool: WorkerPool,
    max_workspaces: int | None,
    proxies: Sequence[str],
    allowed_hosts: Sequence[str],
    idle_grace_seconds: float,
    exit: Callable[[], None],
    pid_file: Path | None = None,
) -> Any:
    """The daemon's server over ``pool``, as an ASGI app that starts and
    stops it. Mirrors TypeScript's ``buildWorkerProxy``.

    Args:
        pool (WorkerPool): the workers.
        max_workspaces (int | None): the most workspaces the workers hold
            together; None for no cap.
        proxies (Sequence[str]): the proxies whose ``X-Forwarded-For``
            names the client.
        allowed_hosts (Sequence[str]): the Hosts it answers, as the
            workers do, since it answers some requests itself.
        idle_grace_seconds (float): how long the workers may hold no
            workspace before the daemon exits.
        exit (Callable[[], None]): stops the daemon.
        pid_file (Path | None): where the daemon's pid is written while it
            runs.
    """
    proxy = WorkerProxy(
        pool, max_workspaces, idle_grace_seconds, exit, pid_file
    )
    checked = HostHeaderMiddleware(cast(Any, proxy), list(allowed_hosts))
    if not proxies:
        return checked
    return ProxyHeadersMiddleware(
        cast(Any, checked), trusted_hosts=list(proxies)
    )
