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
import functools
import json
import logging
import os
import random
import secrets
import shutil
import signal
import sys
import tempfile
import threading
import time
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from types import FrameType
from typing import Any, cast
from urllib.parse import parse_qs, quote

import h11
import httpx
import uvicorn
from fastapi import HTTPException
from starlette.types import Message, Receive, Scope, Send
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
from websockets.asyncio.client import unix_connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from mirage.server.app import build_app
from mirage.server.daemon_config import DaemonConfigError, read_daemon_table
from mirage.server.env import (
    ENV_FORWARDED_ALLOW_IPS,
    ENV_WORKER_SOCKET,
    ENV_WORKER_TOKEN,
    ENV_WORKER_TYPE,
    ENV_WORKERS,
)
from mirage.server.host_validation import HostHeaderMiddleware
from mirage.server.multipart import MAX_REQUEST_PART, PartEvent, part_events
from mirage.server.paths import mirage_home
from mirage.server.rate_limit import COUNTED_HEADER

logger = logging.getLogger(__name__)

# How long a worker has to answer its health check once started.
READY_SECONDS = 60
# How long a stopped worker has to exit before it is killed, past the
# graceful timeout it drains for.
EXIT_SECONDS = 10
# A request that needs no workspace and answers only a signed-in caller:
# what a worker says to it says whether the caller may go on.
AUTH_PROBE = "/v1/jobs?workspace_id=-"
# What FastAPI reads as false in a query flag.
_FALSE = frozenset({"0", "f", "false", "n", "no", "off"})
# Headers that belong to one connection, which are not passed on.
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


class WorkerType(StrEnum):
    """What a worker is: a process of its own, or a thread of the
    daemon's."""

    PROCESS = "process"
    THREAD = "thread"


def resolve_workers(workers: int | None = None) -> int:
    """How many workers the daemon runs: ``workers`` when given, else
    ``$MIRAGE_WORKERS``, else the ``workers`` key in config.toml's
    ``[daemon]`` table, else 1, a daemon that holds every workspace
    itself. Mirrors TypeScript's ``resolveWorkers``.

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
            return 1
    try:
        count = int(value) if not isinstance(value, (bool, float)) else 0
    except ValueError:
        count = 0
    if count < 1:
        raise DaemonConfigError(
            f"workers must be a positive whole number, got {value!r}"
        )
    return count


def resolve_worker_type(worker_type: str | None = None) -> WorkerType:
    """What the workers are: ``worker_type`` when given, else
    ``$MIRAGE_WORKER_TYPE``, else the ``worker_type`` key in config.toml's
    ``[daemon]`` table, else threads on an interpreter without the GIL
    (3.14t) and processes on one with it, whose threads would take turns.
    Mirrors TypeScript's ``resolveWorkerType``.

    Args:
        worker_type (str | None): the type the caller set.

    Raises:
        DaemonConfigError: the type is neither process nor thread.
    """
    value: Any = worker_type
    if value is None:
        value = os.environ.get(ENV_WORKER_TYPE) or read_daemon_table(
            mirage_home()
        ).get("worker_type")
        if value is None or value == "":
            gil = getattr(sys, "_is_gil_enabled", lambda: True)()
            return WorkerType.PROCESS if gil else WorkerType.THREAD
    try:
        return WorkerType(value)
    except ValueError:
        raise DaemonConfigError(
            f"worker_type must be process or thread, got {value!r}"
        ) from None


class Worker:
    """One worker: the whole server, on a socket of its own. A worker that
    exits stays gone, and so do its workspaces. Mirrors TypeScript's
    ``Worker``.

    Args:
        index (int): its place in the pool.
        socket (str): the Unix socket it serves on.
        host (str): a Host it accepts, for its health check.
    """

    def __init__(self, index: int, socket: str, host: str) -> None:
        self.index = index
        self.socket = socket
        self.host = host
        self.live: set[str] = set()
        self.dead = False
        self.on_exit: Callable[[], None] = lambda: None
        self._client: httpx.AsyncClient | None = None

    def http(self) -> httpx.AsyncClient:
        """The HTTP client that reaches it."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                transport=httpx.AsyncHTTPTransport(uds=self.socket),
                base_url=f"http://{self.host}",
                timeout=None,
            )
        return self._client

    async def start(self) -> None:
        """Start it and wait until it answers."""
        await self._launch()
        deadline = time.monotonic() + READY_SECONDS
        while True:
            if self.dead:
                raise RuntimeError(
                    f"mirage: worker {self.index} exited as it started"
                )
            if await _answers(self):
                return
            if time.monotonic() > deadline:
                await self.stop(0)
                raise RuntimeError(
                    f"mirage: worker {self.index} did not answer"
                )
            await asyncio.sleep(0.1)

    async def stop(self, graceful_timeout: float) -> None:
        """Stop it: it drains for ``graceful_timeout``, then exits or is
        ended.

        Args:
            graceful_timeout (float): how long its lines get to finish.
        """
        raise NotImplementedError

    async def close(self) -> None:
        """Close the client that reaches it."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _launch(self) -> None:
        raise NotImplementedError

    def _exited(self, code: int | None) -> None:
        if self.dead:
            return
        self.dead = True
        self.on_exit()
        if code != 0:
            logger.error("mirage: worker %d exited (%s)", self.index, code)


class ProcessWorker(Worker):
    """A worker in a process of its own: the daemon module served by
    uvicorn on its socket. Mirrors TypeScript's ``ProcessWorker``.

    Args:
        index (int): its place in the pool.
        socket (str): the Unix socket it serves on.
        host (str): a Host it accepts, for its health check.
        env (dict[str, str]): its environment.
    """

    def __init__(
        self, index: int, socket: str, host: str, env: dict[str, str]
    ) -> None:
        super().__init__(index, socket, host)
        self._env = env
        self._process: asyncio.subprocess.Process | None = None
        self._watcher: asyncio.Task[None] | None = None

    async def _launch(self) -> None:
        env = {
            **self._env,
            ENV_WORKER_SOCKET: self.socket,
            ENV_WORKERS: "1",
            # Only the daemon reaches a worker's socket, and it names the
            # client it served.
            ENV_FORWARDED_ALLOW_IPS: "*",
        }
        # A worker exits when its stdin closes: the daemon is gone.
        self._process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "uvicorn",
            "mirage.server.daemon:app",
            "--uds",
            self.socket,
            "--log-level",
            "warning",
            env=env,
            stdin=asyncio.subprocess.PIPE,
        )
        self._watcher = asyncio.create_task(self._watch(self._process))

    async def _watch(self, process: asyncio.subprocess.Process) -> None:
        self._exited(await process.wait())

    async def stop(self, graceful_timeout: float) -> None:
        process = self._process
        if process is None or self.dead:
            return
        process.terminate()
        try:
            await asyncio.wait_for(
                process.wait(), graceful_timeout + EXIT_SECONDS
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        if self._watcher is not None:
            await self._watcher


class ThreadWorker(Worker):
    """A worker on a thread of the daemon's, with an event loop of its
    own. Its threads run beside the daemon's only on an interpreter
    without the GIL. Mirrors TypeScript's ``ThreadWorker``.

    Args:
        index (int): its place in the pool.
        socket (str): the Unix socket it serves on.
        host (str): a Host it accepts, for its health check.
        token (str): the pool's ``$MIRAGE_WORKER_TOKEN``.
    """

    def __init__(self, index: int, socket: str, host: str, token: str) -> None:
        super().__init__(index, socket, host)
        self._token = token
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    async def _launch(self) -> None:
        # Only the daemon reaches a worker's socket, and it names the
        # client it served; the daemon keeps the cap. A thread reads the
        # token from the daemon's own environment.
        os.environ[ENV_WORKER_TOKEN] = self._token
        app = build_app(max_workspaces=sys.maxsize, forwarded_allow_ips=["*"])
        self._server = uvicorn.Server(
            uvicorn.Config(app, uds=self.socket, log_level="warning")
        )
        self._loop = asyncio.get_running_loop()
        self._thread = threading.Thread(
            target=self._run,
            args=(self._server,),
            name=f"mirage-worker-{self.index}",
            daemon=True,
        )
        self._thread.start()

    def _run(self, server: uvicorn.Server) -> None:
        code = 0
        try:
            asyncio.run(server.serve())
        except BaseException:
            logger.exception("mirage: worker %d failed", self.index)
            code = 1
        if self._loop is not None and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._exited, code)

    async def stop(self, graceful_timeout: float) -> None:
        server, thread = self._server, self._thread
        if server is None or thread is None or self.dead:
            return
        server.should_exit = True
        await asyncio.to_thread(thread.join, graceful_timeout + EXIT_SECONDS)
        if thread.is_alive():
            server.force_exit = True
            await asyncio.to_thread(thread.join)
        self._exited(0)


class WorkerPool:
    """The workers and which holds each workspace.

    A workspace's worker outlives its close, so its jobs and a create
    under its id reach the worker that has them; a delete forgets it.
    Mirrors TypeScript's ``WorkerPool``.

    Args:
        count (int): how many workers to run.
        worker_type (WorkerType): what they are.
        env (dict[str, str]): a process worker's environment.
        host (str): a Host the workers accept, for their health checks.
        graceful_timeout (float): how long a stopped worker drains its
            lines for.
    """

    def __init__(
        self,
        count: int,
        worker_type: WorkerType,
        env: dict[str, str],
        host: str,
        graceful_timeout: float,
    ) -> None:
        self._graceful_timeout = graceful_timeout
        self._directory = tempfile.mkdtemp(prefix="mirage-workers-")
        self._homes: dict[str, Worker] = {}
        self._pending: dict[str, Worker] = {}
        self._stopping = False
        # Creates being answered, each holding a slot under max_workspaces.
        self.reserved = 0
        # The workers' $MIRAGE_WORKER_TOKEN: a request carrying it was
        # counted against the rate limits already.
        self.token = secrets.token_hex(16)
        self.on_lost: Callable[[], None] = lambda: None
        self.workers: list[Worker] = []
        for i in range(count):
            socket = str(Path(self._directory) / f"{i}.sock")
            worker: Worker = (
                ProcessWorker(
                    i, socket, host, {**env, ENV_WORKER_TOKEN: self.token}
                )
                if worker_type == WorkerType.PROCESS
                else ThreadWorker(i, socket, host, self.token)
            )
            worker.on_exit = functools.partial(self._lost, worker)
            self.workers.append(worker)

    async def start(self) -> None:
        """Start every worker and wait until each answers."""
        await asyncio.gather(*(w.start() for w in self.workers))

    async def stop(self) -> None:
        """Stop every worker: each drains, then exits or is ended."""
        self._stopping = True
        await asyncio.gather(
            *(w.stop(self._graceful_timeout) for w in self.workers)
        )
        for worker in self.workers:
            await worker.close()
        shutil.rmtree(self._directory, ignore_errors=True)

    def first(self) -> Worker | None:
        """The first worker still running, which answers what no
        workspace owns."""
        return next((w for w in self.workers if not w.dead), None)

    def random(self) -> Worker | None:
        """A worker still running, at random: where a new workspace
        goes."""
        running = [w for w in self.workers if not w.dead]
        return random.choice(running) if running else None

    def building(self, workspace_id: str) -> Worker | None:
        """The worker now creating ``workspace_id``, else None."""
        return self._pending.get(workspace_id)

    def home(self, workspace_id: str) -> Worker | None:
        """The worker holding, last holding or now creating
        ``workspace_id``, else None.

        Args:
            workspace_id (str): the workspace.
        """
        return self._homes.get(workspace_id) or self._pending.get(workspace_id)

    def claim(self, workspace_id: str, worker: Worker) -> Callable[[], None]:
        """Send the creates of ``workspace_id`` to ``worker`` until the
        returned call.

        Args:
            workspace_id (str): the id being created.
            worker (Worker): the worker creating it.
        """
        self._pending[workspace_id] = worker

        def settle() -> None:
            if self._pending.get(workspace_id) is worker:
                del self._pending[workspace_id]

        return settle

    def adopt(self, workspace_id: str, worker: Worker) -> None:
        """Record ``workspace_id`` as held by ``worker``.

        Args:
            workspace_id (str): the workspace.
            worker (Worker): the worker that built it.
        """
        if worker.dead:
            return
        previous = self._homes.get(workspace_id)
        if previous is not None and previous is not worker:
            previous.live.discard(workspace_id)
        self._homes[workspace_id] = worker
        worker.live.add(workspace_id)

    def release(self, workspace_id: str) -> None:
        """Record ``workspace_id`` as closed: its worker stays its home.

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
        """How many workspaces the workers hold, those being created among
        them."""
        return self.count() + self.reserved

    def count(self) -> int:
        """How many workspaces the workers hold."""
        return sum(len(w.live) for w in self.workers)

    def _lost(self, worker: Worker) -> None:
        """A worker that exited: its workspaces are gone with it."""
        if self._stopping:
            return
        for workspace_id in [i for i, w in self._homes.items() if w is worker]:
            del self._homes[workspace_id]
        worker.live.clear()
        self.on_lost()


@dataclass
class _Answer:
    """What a worker answered, whole."""

    status: int
    headers: list[tuple[str, str]]
    body: bytes


@dataclass
class _Peeked:
    """A request's body as far as it was read.

    Attributes:
        head (bytes): what was read, sent on first.
        more (bool): whether more of the body follows.
        id (str | None): the workspace id the body names, if it names one.
        lost (bool): whether the body passed ``MAX_REQUEST_PART`` before
            naming its id.
        twice (bool): whether a multipart load's ``request`` part comes
            twice in a row.
    """

    head: bytes
    more: bool
    id: str | None
    lost: bool = False
    twice: bool = False


_UNAVAILABLE = _Answer(
    502,
    [("content-type", "application/json")],
    b'{"detail":"worker unavailable"}',
)


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
            return await _reply(send, _UNAVAILABLE)
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
            return await _send(
                send, 200 if status == "ready" else 503, {"status": status}
            )
        if resource == "shutdown" and len(parts) == 2 and method == "POST":
            # A worker answers whether the caller may stop the daemon.
            answer = await self._fetch(first, scope, b"", receive)
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
            return await self._find(scope, receive, send, first)
        if resource != "workspaces":
            return await self._pass(first, scope, receive, send)
        if workspace_id is None:
            if method == "GET":
                return await self._gather(scope, send, "created_at")
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
            return await _reply(send, answer)
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
            return await _send(
                send, 503, {"detail": "server is shutting down"}
            )
        reserved = False
        try:
            refused = await self._refused(scope, source or pool.first())
            if refused is not None:
                return await _reply(send, refused)
            peeked = await _peek(scope, receive)
            if peeked.lost:
                return await _send(
                    send,
                    413,
                    {
                        "detail": "the workspace id must come in the body's "
                        f"first {MAX_REQUEST_PART} bytes"
                    },
                )
            if peeked.twice:
                return await _send(
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
                return await _send(
                    send,
                    503,
                    {
                        "detail": "server is at max_workspaces "
                        f"({self.max_workspaces})"
                    },
                )
            building = pool.building(named) if named is not None else None
            if source is not None and building not in (None, source):
                return await _send(
                    send,
                    409,
                    {"detail": f"workspace id already exists: {named}"},
                )
            # A clone builds on its source's worker, so an id another
            # worker holds, even closed with its jobs, stays there: a
            # create reaches it.
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
                return await _send(send, 409, {"detail": detail})
            alive = home if home is not None and not home.dead else None
            worker = source or alive or pool.random()
            if worker is None:
                return await _reply(send, _UNAVAILABLE)
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
                    made = _id_of(answer.body)
                    if made is not None:
                        pool.adopt(made, worker)
                await _reply(send, answer)
            finally:
                if settle is not None:
                    settle()
        finally:
            if reserved:
                pool.reserved -= 1
            self._idle_check()

    async def _gather(self, scope: Scope, send: Send, order: str) -> None:
        """A list: every worker's, merged in ``order``."""
        running = [w for w in self.pool.workers if not w.dead]
        answers = await asyncio.gather(
            *(self._fetch(w, scope, b"") for w in running)
        )
        for answer in answers:
            if answer.status != 200:
                return await _reply(send, answer)
        items = [item for a in answers for item in json.loads(a.body)]
        items.sort(key=lambda item: float(item.get(order) or 0))
        await _send(send, 200, items)

    async def _find(
        self, scope: Scope, receive: Receive, send: Send, first: Worker
    ) -> None:
        """A job's request: the worker that knows the job answers."""
        refused = await self._refused(scope, first)
        if refused is not None:
            return await _reply(send, refused)
        body = await _read_up_to(receive, MAX_REQUEST_PART)
        if body is None:
            return await _send(send, 413, {"detail": "request body too large"})
        answer: _Answer | None = None
        for worker in self.pool.workers:
            if worker.dead:
                continue
            answer = await self._fetch(worker, scope, body, counted=True)
            if answer.status != 404:
                break
        await _reply(send, answer or _UNAVAILABLE)

    async def _refused(
        self, scope: Scope, worker: Worker | None
    ) -> _Answer | None:
        """A worker's refusal of the caller, asked before a body is read:
        None when the caller may go on."""
        if worker is None:
            return None
        headers = [
            (k, v)
            for k, v in _headers_for(scope)
            if k not in ("content-length", "content-type")
        ]
        try:
            response = await worker.http().get(AUTH_PROBE, headers=headers)
        except httpx.TransportError as exc:
            logger.debug(
                "mirage: worker %d did not answer: %s", worker.index, exc
            )
            return _UNAVAILABLE
        if response.status_code < 300:
            return None
        return _answered(response)

    async def _holds(
        self, worker: Worker, scope: Scope, workspace_id: str
    ) -> bool:
        """Whether ``worker`` still holds workspace ``workspace_id``."""
        headers = [
            (k, v)
            for k, v in _headers_for(scope)
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
        headers = _headers_for(scope)
        if counted:
            # The caller check counted it already against the rate limits.
            headers.append((COUNTED_HEADER, self.pool.token))
        return worker.http().build_request(
            scope["method"], _target(scope), headers=headers, content=content
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
            return await _reply(send, _UNAVAILABLE)
        connection = h11.Connection(h11.CLIENT)
        writer.write(
            connection.send(
                h11.Request(
                    method=scope["method"],
                    target=_target(scope),
                    headers=_framed(scope, worker.host),
                )
            )
        )
        sent = asyncio.Event()

        async def upload() -> None:
            try:
                async for chunk in _chunks(receive):
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
                                "headers": _passable(list(event.headers)),
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
                    await _reply(send, _UNAVAILABLE)

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
                self._request(worker, scope, content, counted)
            )
        except httpx.TransportError as exc:
            logger.debug(
                "mirage: worker %d did not answer: %s", worker.index, exc
            )
            return _UNAVAILABLE
        return _answered(response)

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
        worker = (
            home if home is not None and not home.dead else self.pool.first()
        )
        if worker is None:
            await send({"type": "websocket.close", "code": 1011})
            return
        headers = _headers_for(scope)
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
                        "headers": _passable(raw),
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


def _path_parts(path: str) -> list[str]:
    """The segments of a request's path, which ASGI has decoded."""
    return path.split("/")[1:]


async def _answers(worker: Worker) -> bool:
    """Whether ``worker`` answers its health check."""
    try:
        response = await worker.http().get("/v1/health", timeout=1)
    except httpx.TransportError as exc:
        # A worker still starting refuses its socket; the caller retries.
        logger.debug(
            "mirage: worker %d did not answer its health check: %s",
            worker.index,
            exc,
        )
        return False
    return response.status_code == 200


def _answered(response: httpx.Response) -> _Answer:
    """A worker's whole answer."""
    return _Answer(
        response.status_code,
        [(k.decode(), v.decode()) for k, v in response.headers.raw],
        response.content,
    )


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
        # Only the daemon says a request was counted.
        and k not in ("x-forwarded-for", "content-length", COUNTED_HEADER)
    ]
    kept.append(("x-forwarded-for", client[0] if client else ""))
    return kept


def _target(scope: Scope) -> str:
    """A request's path and query, as the client sent them."""
    path: bytes = scope.get("raw_path") or scope["path"].encode()
    query: bytes = scope.get("query_string", b"")
    return path.decode("latin-1") + ("?" + query.decode() if query else "")


def _framed(scope: Scope, host: str) -> list[tuple[str, str]]:
    """A request's headers for its worker, with its body framed as the
    client framed it."""
    headers = _headers_for(scope)
    sent = {
        k.decode("latin-1").lower(): v.decode("latin-1")
        for k, v in scope["headers"]
    }
    if "content-length" in sent:
        headers.append(("content-length", sent["content-length"]))
    elif "transfer-encoding" in sent:
        headers.append(("transfer-encoding", "chunked"))
    if not any(k == "host" for k, _ in headers):
        headers.append(("host", host))
    return headers


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
    """The workspace id a create names: its ``id``, else its config's
    ``workspace_id``."""
    try:
        parsed = json.loads(body)
    except ValueError as exc:
        # The worker refuses a body that is not JSON; it names no id here.
        logger.debug(
            "mirage: a create body is not JSON: %s", type(exc).__name__
        )
        return None
    if not isinstance(parsed, dict):
        return None
    config = parsed.get("config")
    made = parsed.get("id")
    if made is None and isinstance(config, dict):
        made = config.get("workspace_id")
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


async def _read_up_to(receive: Receive, limit: int) -> bytes | None:
    """The whole request body, None past ``limit`` bytes."""
    read: list[bytes] = []
    size = 0
    async for chunk in _chunks(receive):
        size += len(chunk)
        if size > limit:
            return None
        read.append(chunk)
    return b"".join(read)


async def _peek(scope: Scope, receive: Receive) -> _Peeked:
    """Read a create's body, up to ``MAX_REQUEST_PART``, until the
    workspace id it names is known: a JSON body whole, or a multipart
    load's parts up to the end of its ``request`` part. Past the limit the
    id is not known.

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
            # Checked once the chunk is parsed: it may end the request part
            # and run past the limit, and bytes before the first part make
            # no event.
            if size > MAX_REQUEST_PART:
                return

    if not content_type.startswith("multipart/"):
        async for _ in read():
            if size > MAX_REQUEST_PART:
                return _Peeked(b"".join(chunks), more, None, lost=True)
        head = b"".join(chunks)
        return _Peeked(head, False, _id_of(head))
    request: list[bytes] = []
    name = b""
    named = False
    twice = False
    events = part_events(read(), content_type)
    try:
        async for kind, value in events:
            # Read on to the next part, which must not be a second request.
            if kind == PartEvent.BEGIN:
                if name == b"request":
                    twice = value == b"request"
                    break
                name = value
            elif kind == PartEvent.DATA and name == b"request":
                request.append(bytes(value))
            elif kind == PartEvent.END and name == b"request":
                named = True
    except HTTPException as exc:
        # A malformed body goes on as it is, for the worker to refuse.
        logger.debug("mirage: a load body did not parse: %s", exc.detail)
    finally:
        await events.aclose()
    return _Peeked(
        b"".join(chunks),
        more,
        _id_of(b"".join(request)),
        lost=not named and size > MAX_REQUEST_PART,
        twice=twice,
    )
