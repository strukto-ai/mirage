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
import logging
import os
import sys
import threading
import time
from collections.abc import Callable

import httpx
import uvicorn

from mirage.server.app import build_app
from mirage.server.env import (
    ENV_FORWARDED_ALLOW_IPS,
    ENV_WORKER_SOCKET,
    ENV_WORKER_TOKEN,
    ENV_WORKERS,
)
from mirage.server.workers.constants import EXIT_SECONDS, READY_SECONDS

logger = logging.getLogger(__name__)


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
            if await answers(self):
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


async def answers(worker: Worker) -> bool:
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
