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
"""The daemon as a front and worker processes.

With ``workers`` above 1 the daemon's process is a front: it starts that
many workers, each the whole server on a socket of its own, and hands
each new workspace to the worker holding the fewest. Every request about
a workspace goes to the worker holding it, so each worker's workspaces
share its interpreter and nothing else. Lists, health and readiness are
the front's own, over every worker. On Linux, ``cpus`` pins worker i to
the i-th CPU of the list, with ``taskset``.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import time
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs, unquote

import httpx
from fastapi import HTTPException
from starlette.types import Receive, Scope, Send
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
from websockets.asyncio.client import unix_connect
from websockets.exceptions import ConnectionClosed

from mirage.server.daemon_config import DaemonConfigError, read_daemon_table
from mirage.server.env import (
    ENV_CPUS,
    ENV_FORWARDED_ALLOW_IPS,
    ENV_WORKER_SOCKET,
    ENV_WORKERS,
)
from mirage.server.multipart import (
    MAX_REQUEST_PART,
    MAX_SNAPSHOT_PART,
    PartEvent,
    part_events,
)
from mirage.server.paths import mirage_home

logger = logging.getLogger(__name__)

# How long a worker has to answer its health check once started.
READY_SECONDS = 60
# How long a stopped worker has to exit before it is killed, past the
# graceful timeout it drains for.
EXIT_SECONDS = 10
# How long the front waits before starting a worker that exited again.
RESTART_SECONDS = 1
# The most CPUs one range of a ``cpus`` list may name.
MAX_CPUS = 4096
# Headers that belong to one connection, which the front does not pass on.
HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
# One item of a ``cpus`` list: a CPU or a range of them.
CPU_RANGE = re.compile(r"^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$")


def parse_cpu_list(text: str) -> list[int]:
    """The CPUs a ``cpus`` setting names, in order: ``0-3,6`` is 0, 1,
    2, 3 and 6. Mirrors TypeScript's ``parseCpuList``.

    Args:
        text (str): the CPU list.

    Raises:
        DaemonConfigError: ``text`` is not a CPU list.
    """
    cpus: list[int] = []
    for item in text.split(","):
        match = CPU_RANGE.match(item)
        first = int(match.group(1)) if match else -1
        last = int(match.group(2)) if match and match.group(2) else first
        if first < 0 or last < first or last - first >= MAX_CPUS:
            raise DaemonConfigError(
                f"cpus must be a CPU list such as 0-3,6, got {text!r}"
            )
        for cpu in range(first, last + 1):
            if cpu not in cpus:
                cpus.append(cpu)
    return cpus


def resolve_cpus(cpus: str | None = None) -> list[int] | None:
    """The CPUs the workers are pinned to: ``cpus`` when given, else
    ``$MIRAGE_CPUS``, else the ``cpus`` key in config.toml's ``[daemon]``
    table, else None for none. Mirrors TypeScript's ``resolveCpus``.

    Args:
        cpus (str | None): the CPU list the caller set.

    Raises:
        DaemonConfigError: the setting is not a CPU list.
    """
    value: Any = cpus
    if value is None:
        value = os.environ.get(ENV_CPUS) or read_daemon_table(
            mirage_home()
        ).get("cpus")
        if value is None or value == "":
            return None
    return parse_cpu_list(str(value))


def resolve_workers(workers: int | None = None) -> int:
    """How many worker processes the daemon runs: ``workers`` when given,
    else ``$MIRAGE_WORKERS``, else the ``workers`` key in config.toml's
    ``[daemon]`` table, else one per CPU of ``cpus``, else 1, a daemon of
    one process. Mirrors TypeScript's ``resolveWorkers``.

    Args:
        workers (int | None): the count the caller set.

    Raises:
        DaemonConfigError: the count is not a positive whole number.
    """
    value: Any = workers
    if value is None:
        value = os.environ.get(ENV_WORKERS) or read_daemon_table(
            mirage_home()
        ).get("workers")
        if value is None or value == "":
            cpus = resolve_cpus()
            return 1 if cpus is None else len(cpus)
    try:
        count = int(value) if not isinstance(value, (bool, float)) else 0
    except ValueError:
        count = 0
    if count < 1:
        raise DaemonConfigError(
            f"workers must be a positive whole number, got {value!r}"
        )
    return count


@dataclass(eq=False)
class Worker:
    """One worker process: the whole server, on a socket of its own.

    Attributes:
        index (int): its place in the pool.
        socket (str): the Unix socket it serves on.
        cpu (int | None): the CPU it is pinned to, None when it is not.
        process (asyncio.subprocess.Process | None): the running process.
        live (set[str]): the ids of the workspaces it holds.
        building (int): the creates in flight on it.
    """

    index: int
    socket: str
    cpu: int | None
    process: asyncio.subprocess.Process | None = None
    live: set[str] = field(default_factory=set)
    building: int = 0
    client: httpx.AsyncClient | None = None

    def http(self) -> httpx.AsyncClient:
        """The HTTP client that reaches it."""
        if self.client is None:
            self.client = httpx.AsyncClient(
                transport=httpx.AsyncHTTPTransport(uds=self.socket),
                base_url="http://localhost",
                timeout=None,
            )
        return self.client


class WorkerPool:
    """The worker processes and which holds each workspace.

    A workspace's home outlives its close, so its jobs and a create under
    its id reach the worker that has them; a delete forgets it. Mirrors
    TypeScript's ``WorkerPool``.

    Args:
        count (int): how many workers to run.
        cpus (Sequence[int] | None): the CPUs to pin them to, in order;
            None pins none.
        command (Sequence[str]): the command a worker runs; ``{socket}``
            in it is the worker's socket.
        env (dict[str, str]): the workers' environment.
        graceful_timeout (float): how long a stopped worker drains its
            lines for.
    """

    def __init__(
        self,
        count: int,
        cpus: Sequence[int] | None,
        command: Sequence[str],
        env: dict[str, str],
        graceful_timeout: float,
    ) -> None:
        if cpus is not None and not sys.platform.startswith("linux"):
            logger.warning(
                "mirage: cpus pins workers on Linux only; "
                "the workers run unpinned"
            )
            cpus = None
        if cpus is not None and shutil.which("taskset") is None:
            raise DaemonConfigError(
                "cpus pins workers with taskset, which is not on PATH"
            )
        self._command = list(command)
        self._env = dict(env)
        self._graceful_timeout = graceful_timeout
        self._directory = tempfile.mkdtemp(prefix="mirage-workers-")
        self._homes: dict[str, Worker] = {}
        self._stopping = False
        self._watchers: set[asyncio.Task[None]] = set()
        self.on_lost: Callable[[], None] = lambda: None
        self.workers = [
            Worker(
                index=i,
                socket=str(Path(self._directory) / f"{i}.sock"),
                cpu=cpus[i % len(cpus)] if cpus else None,
            )
            for i in range(count)
        ]

    async def start(self) -> None:
        """Start every worker and wait until each answers."""
        await asyncio.gather(*(self._launch(w) for w in self.workers))

    async def stop(self) -> None:
        """Stop every worker: each drains, then exits or is killed."""
        self._stopping = True
        await asyncio.gather(*(self._halt(w) for w in self.workers))
        for worker in self.workers:
            if worker.client is not None:
                await worker.client.aclose()
                worker.client = None
        shutil.rmtree(self._directory, ignore_errors=True)

    def home(self, workspace_id: str) -> Worker | None:
        """The worker holding or last holding ``workspace_id``, else None.

        Args:
            workspace_id (str): the workspace.
        """
        return self._homes.get(workspace_id)

    def least_loaded(self) -> Worker:
        """The worker a new workspace goes to: the one holding the
        fewest."""
        return min(self.workers, key=lambda w: len(w.live) + w.building)

    def adopt(self, workspace_id: str, worker: Worker) -> None:
        """Record ``workspace_id`` as held by ``worker``.

        Args:
            workspace_id (str): the workspace.
            worker (Worker): the worker that built it.
        """
        previous = self._homes.get(workspace_id)
        if previous is not None and previous is not worker:
            previous.live.discard(workspace_id)
        self._homes[workspace_id] = worker
        worker.live.add(workspace_id)

    def release(self, workspace_id: str) -> None:
        """Record ``workspace_id`` as closed: its home stays.

        Args:
            workspace_id (str): the workspace.
        """
        worker = self._homes.get(workspace_id)
        if worker is not None:
            worker.live.discard(workspace_id)

    def forget(self, workspace_id: str) -> None:
        """Record ``workspace_id`` as deleted.

        Args:
            workspace_id (str): the workspace.
        """
        self.release(workspace_id)
        self._homes.pop(workspace_id, None)

    def held(self) -> int:
        """How many workspaces the workers hold, and how many are being
        built."""
        return sum(len(w.live) + w.building for w in self.workers)

    def live(self) -> int:
        """How many workspaces the workers hold."""
        return sum(len(w.live) for w in self.workers)

    async def _launch(self, worker: Worker) -> None:
        argv = [
            arg.replace("{socket}", worker.socket) for arg in self._command
        ]
        if worker.cpu is not None:
            argv = ["taskset", "-c", str(worker.cpu), *argv]
        env = {
            **self._env,
            ENV_WORKER_SOCKET: worker.socket,
            ENV_WORKERS: "1",
            # Only the front reaches a worker's socket, and it names the
            # client it served.
            ENV_FORWARDED_ALLOW_IPS: "*",
        }
        # A worker exits when its stdin closes: the front is gone.
        process = await asyncio.create_subprocess_exec(
            *argv, env=env, stdin=asyncio.subprocess.PIPE
        )
        worker.process = process
        watcher = asyncio.create_task(self._watch(worker, process))
        self._watchers.add(watcher)
        watcher.add_done_callback(self._watchers.discard)
        deadline = time.monotonic() + READY_SECONDS
        while True:
            if worker.process is not process:
                raise RuntimeError(
                    f"mirage: worker {worker.index} exited as it started"
                )
            if await _answers(worker):
                return
            if time.monotonic() > deadline:
                process.kill()
                raise RuntimeError(
                    f"mirage: worker {worker.index} did not answer"
                )
            await asyncio.sleep(0.1)

    async def _watch(
        self, worker: Worker, process: asyncio.subprocess.Process
    ) -> None:
        code = await process.wait()
        if worker.process is process:
            worker.process = None
        if self._stopping:
            return
        # A worker that exited: its workspaces are gone, and it starts
        # again.
        logger.error(
            "mirage: worker %d exited (%s); restarting it", worker.index, code
        )
        for workspace_id in [
            i for i, home in self._homes.items() if home is worker
        ]:
            del self._homes[workspace_id]
        worker.live.clear()
        self.on_lost()
        await asyncio.sleep(RESTART_SECONDS)
        if self._stopping:
            return
        try:
            await self._launch(worker)
        except RuntimeError as exc:
            logger.error("%s", exc)

    async def _halt(self, worker: Worker) -> None:
        process = worker.process
        if process is None or process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(
                process.wait(), self._graceful_timeout + EXIT_SECONDS
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()


@dataclass
class _Answer:
    """What a worker answered, whole."""

    status: int
    headers: list[tuple[str, str]]
    body: bytes


@dataclass
class _Peeked:
    """A request's body as far as the front read it.

    Attributes:
        head (bytes): what was read, sent on first.
        more (bool): whether more of the body follows.
        id (str | None): the workspace id the body names, if it names one.
    """

    head: bytes
    more: bool
    id: str | None


class Front:
    """The front: an ASGI app that sends each request to the worker
    holding its workspace. Mirrors TypeScript's ``Front``.

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
        self.pid_file = pid_file
        self.max_workspaces = max_workspaces
        self.idle_grace_seconds = idle_grace_seconds
        self.exit = exit
        self.draining = False
        self._idle: asyncio.TimerHandle | None = None
        self._started_at = time.time()
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
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                self.draining = True
                self._cancel_idle()
                await self.pool.stop()
                if self.pid_file is not None:
                    self.pid_file.unlink(missing_ok=True)
                await send({"type": "lifespan.shutdown.complete"})
                return

    async def _handle(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        pool = self.pool
        first = pool.workers[0]
        parts = _path_parts(scope["path"])
        method = scope["method"]
        if parts[:1] != ["v1"]:
            return await self._pass(first, scope, receive, send)
        resource = parts[1] if len(parts) > 1 else None
        workspace_id = parts[2] if len(parts) > 2 else None
        action = parts[3] if len(parts) > 3 else None
        if resource == "health" and len(parts) == 2 and method == "GET":
            return await _send(
                send,
                200,
                {
                    "status": "ok",
                    "workspaces": pool.live(),
                    "uptime_s": round(time.time() - self._started_at, 3),
                    "workers": len(pool.workers),
                },
            )
        if resource == "ready" and len(parts) == 2 and method == "GET":
            status = (
                "shutting_down"
                if self.draining
                else "ready"
                if self._has_room(own=False)
                else "full"
            )
            return await _send(
                send, 200 if status == "ready" else 503, {"status": status}
            )
        if resource == "shutdown" and len(parts) == 2 and method == "POST":
            # A worker answers whether the caller may stop the daemon.
            answer = await self._fetch(first, scope, await _read_all(receive))
            if answer.status != 200:
                return await _reply(send, answer)
            await _send(
                send, 200, {"status": "shutting_down", "pid": os.getpid()}
            )
            self.exit()
            return
        if resource == "jobs":
            if workspace_id is None:
                query = parse_qs(scope.get("query_string", b"").decode())
                owner = query.get("workspace_id")
                if owner:
                    worker = pool.home(owner[0]) or first
                    return await self._pass(worker, scope, receive, send)
                return await self._gather(scope, send, "submitted_at")
            return await self._find(scope, receive, send)
        if resource != "workspaces":
            return await self._pass(first, scope, receive, send)
        if workspace_id is None:
            if method == "GET":
                return await self._gather(scope, send, "created_at")
            if method == "POST":
                return await self._create(scope, receive, send, None)
            return await self._pass(first, scope, receive, send)
        if workspace_id == "load" and len(parts) == 3 and method == "POST":
            return await self._create(scope, receive, send, None)
        home = pool.home(workspace_id)
        if home is None:
            return await self._pass(first, scope, receive, send)
        if action == "clone" and len(parts) == 4 and method == "POST":
            return await self._create(scope, receive, send, home)
        if action is None and method == "DELETE":
            answer = await self._fetch(home, scope, await _read_all(receive))
            if answer.status < 300:
                pool.forget(workspace_id)
                self._idle_check()
            return await _reply(send, answer)
        if action == "close" and len(parts) == 4 and method == "POST":
            answer = await self._fetch(home, scope, await _read_all(receive))
            if answer.status < 300:
                pool.release(workspace_id)
                self._idle_check()
            return await _reply(send, answer)
        return await self._pass(home, scope, receive, send)

    async def _create(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
        source: Worker | None,
    ) -> None:
        """A create, load or clone: to the worker already holding the id
        it names, else to ``source``'s for a clone, else to the least
        loaded."""
        pool = self.pool
        if self.draining:
            return await _send(
                send, 503, {"detail": "server is shutting down"}
            )
        if not self._has_room(own=False):
            return await _send(
                send,
                503,
                {
                    "detail": "server is at max_workspaces "
                    f"({self.max_workspaces})"
                },
            )
        peeked = await _peek(scope, receive)
        named = peeked.id
        held = pool.home(named) if named is not None else None
        if (
            source is not None
            and held is not None
            and held is not source
            and named in held.live
        ):
            return await _send(
                send, 409, {"detail": f"workspace id already exists: {named}"}
            )
        worker = source or held or pool.least_loaded()
        worker.building += 1
        self._cancel_idle()
        try:
            answer = await self._fetch(
                worker, scope, peeked.head, receive if peeked.more else None
            )
            if answer.status == 201:
                made = _id_of(answer.body)
                if made is not None:
                    pool.adopt(made, worker)
            await _reply(send, answer)
        finally:
            worker.building -= 1
            self._idle_check()

    async def _gather(self, scope: Scope, send: Send, order: str) -> None:
        """A list: every worker's, merged in ``order``."""
        answers = await asyncio.gather(
            *(self._fetch(w, scope, b"") for w in self.pool.workers)
        )
        for answer in answers:
            if answer.status != 200:
                return await _reply(send, answer)
        items = [item for a in answers for item in json.loads(a.body)]
        items.sort(key=lambda item: float(item.get(order) or 0))
        await _send(send, 200, items)

    async def _find(self, scope: Scope, receive: Receive, send: Send) -> None:
        """A job's request: the worker that knows the job answers."""
        body = await _read_all(receive)
        answer: _Answer | None = None
        for worker in self.pool.workers:
            answer = await self._fetch(worker, scope, body)
            if answer.status != 404:
                break
        assert answer is not None
        await _reply(send, answer)

    def _has_room(self, own: bool) -> bool:
        cap = self.max_workspaces
        return cap is None or self.pool.held() + (0 if own else 1) <= cap

    def _request(
        self, worker: Worker, scope: Scope, content: Any
    ) -> httpx.Request:
        path = scope.get("raw_path") or scope["path"].encode()
        query = scope.get("query_string", b"")
        url = path.decode("latin-1") + ("?" + query.decode() if query else "")
        return worker.http().build_request(
            scope["method"],
            url,
            headers=_headers_for(scope),
            content=content,
        )

    async def _pass(
        self, worker: Worker, scope: Scope, receive: Receive, send: Send
    ) -> None:
        """Pass a request through to ``worker``, streaming both ways."""
        request = self._request(worker, scope, _chunks(receive))
        try:
            response = await worker.http().send(request, stream=True)
        except httpx.TransportError:
            return await _send(send, 502, {"detail": "worker unavailable"})
        try:
            await send(
                {
                    "type": "http.response.start",
                    "status": response.status_code,
                    "headers": _passable(response.headers.raw),
                }
            )
            async for chunk in response.aiter_raw():
                await send(
                    {
                        "type": "http.response.body",
                        "body": chunk,
                        "more_body": True,
                    }
                )
            await send({"type": "http.response.body", "body": b""})
        finally:
            await response.aclose()

    async def _fetch(
        self,
        worker: Worker,
        scope: Scope,
        body: bytes,
        rest: Receive | None = None,
    ) -> _Answer:
        """Send ``body``, and the rest of the request from ``rest``, and
        read the whole answer."""

        async def then(rest: Receive) -> AsyncIterator[bytes]:
            if body:
                yield body
            async for chunk in _chunks(rest):
                yield chunk

        content: Any = body if rest is None else then(rest)
        try:
            response = await worker.http().send(
                self._request(worker, scope, content)
            )
        except httpx.TransportError:
            payload = json.dumps(
                {"detail": "worker unavailable"}, separators=(",", ":")
            ).encode()
            return _Answer(
                502, [("content-type", "application/json")], payload
            )
        return _Answer(
            response.status_code,
            [(k.decode(), v.decode()) for k, v in response.headers.raw],
            response.content,
        )

    async def _websocket(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        """A WebSocket: its messages, to and from the workspace's worker."""
        parts = _path_parts(scope["path"])
        home = (
            self.pool.home(parts[2])
            if len(parts) > 2 and parts[1] == "workspaces"
            else None
        )
        worker = home or self.pool.workers[0]
        query = scope.get("query_string", b"").decode()
        uri = "ws://worker" + scope["path"] + ("?" + query if query else "")
        headers = [
            (k, v)
            for k, v in _headers_for(scope)
            if not k.startswith("sec-websocket-") and k != "host"
        ]
        await receive()
        try:
            upstream = await unix_connect(
                worker.socket,
                uri,
                additional_headers=headers,
                subprotocols=scope.get("subprotocols") or None,
                max_size=None,
            )
        except Exception:
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
            except ConnectionClosed:
                pass
            await send({"type": "websocket.close", "code": 1000})

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


def build_front(
    pool: WorkerPool,
    max_workspaces: int | None,
    proxies: Sequence[str],
    idle_grace_seconds: float,
    exit: Callable[[], None],
    pid_file: Path | None = None,
) -> Any:
    """The front over ``pool``, as an ASGI app that starts and stops it.
    Mirrors TypeScript's ``buildFront``.

    Args:
        pool (WorkerPool): the workers.
        max_workspaces (int | None): the most workspaces the workers hold
            together; None for no cap.
        proxies (Sequence[str]): the proxies whose ``X-Forwarded-For``
            names the client.
        idle_grace_seconds (float): how long the workers may hold no
            workspace before the daemon exits.
        exit (Callable[[], None]): stops the daemon.
        pid_file (Path | None): where the daemon's pid is written while it
            runs.
    """
    front = Front(pool, max_workspaces, idle_grace_seconds, exit, pid_file)
    if not proxies:
        return front
    return ProxyHeadersMiddleware(
        cast(Any, front), trusted_hosts=list(proxies)
    )


def _path_parts(path: str) -> list[str]:
    """The decoded segments of a request's path."""
    return [unquote(segment) for segment in path.split("/")[1:]]


async def _answers(worker: Worker) -> bool:
    """Whether ``worker`` answers its health check."""
    try:
        response = await worker.http().get("/v1/health", timeout=1)
    except httpx.TransportError:
        return False
    return response.status_code == 200


def _headers_for(scope: Scope) -> list[tuple[str, str]]:
    headers = [
        (k.decode("latin-1").lower(), v.decode("latin-1"))
        for k, v in scope["headers"]
    ]
    client = scope.get("client")
    kept = [
        (k, v)
        for k, v in headers
        if k not in HOP_BY_HOP
        and k not in ("x-forwarded-for", "content-length")
    ]
    kept.append(("x-forwarded-for", client[0] if client else ""))
    return kept


def _passable(raw: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    return [
        (k, v) for k, v in raw if k.decode("latin-1").lower() not in HOP_BY_HOP
    ]


async def _send(send: Send, status: int, body: Any) -> None:
    payload = json.dumps(body, separators=(",", ":")).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})


async def _reply(send: Send, answer: _Answer) -> None:
    headers = [
        (k.encode("latin-1"), v.encode("latin-1"))
        for k, v in answer.headers
        if k.lower() not in HOP_BY_HOP and k.lower() != "content-length"
    ]
    headers.append((b"content-length", str(len(answer.body)).encode()))
    await send(
        {
            "type": "http.response.start",
            "status": answer.status,
            "headers": headers,
        }
    )
    await send({"type": "http.response.body", "body": answer.body})


def _id_of(body: bytes) -> str | None:
    try:
        made = json.loads(body).get("id")
    except (ValueError, AttributeError):
        return None
    return made if isinstance(made, str) else None


async def _chunks(receive: Receive) -> AsyncIterator[bytes]:
    while True:
        message = await receive()
        if message["type"] != "http.request":
            return
        if message.get("body"):
            yield message["body"]
        if not message.get("more_body"):
            return


async def _read_all(receive: Receive) -> bytes:
    return b"".join([chunk async for chunk in _chunks(receive)])


async def _peek(scope: Scope, receive: Receive) -> _Peeked:
    """Read a create's body until the workspace id it names is known: a
    JSON body whole, up to ``MAX_REQUEST_PART``, or a multipart load's
    parts up to the end of its ``request`` part.

    Returns:
        _Peeked: what was read, whether more follows, and the id.
    """
    content_type = ""
    for k, v in scope["headers"]:
        if k.lower() == b"content-type":
            content_type = v.decode("latin-1")
    chunks: list[bytes] = []
    size = 0
    more = True
    if not content_type.startswith("multipart/"):
        while more:
            message = await receive()
            chunk = message.get("body", b"")
            more = (
                bool(message.get("more_body"))
                and message["type"] == "http.request"
            )
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_REQUEST_PART:
                return _Peeked(b"".join(chunks), more, None)
        head = b"".join(chunks)
        return _Peeked(head, False, _id_of(head))
    # The parts are read from what has arrived; the request part's JSON
    # names the id.

    async def read() -> AsyncIterator[bytes]:
        nonlocal more, size
        while more:
            message = await receive()
            chunk = message.get("body", b"")
            more = (
                bool(message.get("more_body"))
                and message["type"] == "http.request"
            )
            chunks.append(chunk)
            size += len(chunk)
            yield chunk

    request: list[bytes] = []
    name = b""
    events = part_events(read(), content_type)
    try:
        async for kind, value in events:
            if kind == PartEvent.BEGIN:
                if name == b"request":
                    break
                name = value
            elif kind == PartEvent.DATA and name == b"request":
                request.append(bytes(value))
            elif kind == PartEvent.END and name == b"request":
                break
            if size > MAX_REQUEST_PART + MAX_SNAPSHOT_PART:
                break
    except HTTPException:
        # A malformed body goes on as it is, for the worker to refuse.
        pass
    finally:
        await events.aclose()
    return _Peeked(b"".join(chunks), more, _id_of(b"".join(request)))
