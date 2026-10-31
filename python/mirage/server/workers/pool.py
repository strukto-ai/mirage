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
import random
import secrets
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from mirage.server.env import (
    ENV_WORKER_TOKEN,
)
from mirage.server.workers.types import WorkerType
from mirage.server.workers.worker import (
    ProcessWorker,
    ThreadWorker,
    Worker,
)


class WorkerPool:
    """The workers and which holds each workspace.

    A workspace's worker outlives its close, so a create under its id
    reaches the worker that has its state; a delete forgets it.
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
