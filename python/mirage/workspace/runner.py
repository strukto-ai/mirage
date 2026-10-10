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
import concurrent.futures
import logging
import threading
from typing import Any, Coroutine, TypeVar

from mirage.concurrency.limiter import settle
from mirage.workspace.workspace import Workspace

logger = logging.getLogger(__name__)

T = TypeVar("T")


class WorkspaceRunner:
    """A Workspace pinned to its own thread and asyncio event loop.

    Use this when the calling app already has its own event loop
    (FastAPI, aiohttp, the Mirage daemon, etc.) and wants the
    workspace to run in isolation -- so a slow / blocking call inside
    the workspace cannot stall the host loop, and so multiple
    workspaces hosted in one process do not interfere with each other.

    The workspace's coroutines run only on the workspace loop. Callers
    dispatch work via :meth:`call`, which is safe from any other
    asyncio loop and refused once :meth:`stop` begins.

    Example:

        ws = Workspace({"/": (RAMVFS(), MountMode.WRITE)})
        runner = WorkspaceRunner(ws)
        try:
            result = await runner.call(runner.ws.shell("ls /"))
        finally:
            await runner.stop()
    """

    def __init__(self, ws: Workspace) -> None:
        """Construct the runner and start its background loop.

        Args:
            ws (Workspace): the workspace this runner owns. The runner
                takes exclusive responsibility for running the
                workspace's coroutines from this point forward.
        """
        self.ws = ws
        self.loop = asyncio.new_event_loop()
        self._stopped = False
        self._stopping: asyncio.Task[None] | None = None
        self._thread = threading.Thread(
            target=self._run,
            name=f"mirage-ws-{id(ws):x}",
            daemon=True,
        )
        self._thread.start()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _schedule(
        self, coro: Coroutine[Any, Any, T]
    ) -> concurrent.futures.Future[T]:
        if self._stopped:
            coro.close()
            raise RuntimeError("WorkspaceRunner is stopped")
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    async def call(self, coro: Coroutine[Any, Any, T]) -> T:
        """Run ``coro`` on the workspace loop and await the result.

        Safe to call from any other event loop. The current loop is
        not blocked while the workspace loop processes ``coro``. A
        cancelled caller cancels ``coro`` there and returns only once it
        has settled, so nothing it holds outlives the call.

        Args:
            coro (Awaitable[T]): a coroutine produced from the
                workspace's API, e.g. ``runner.ws.shell("ls /")``.

        Returns:
            T: whatever ``coro`` resolves to.

        Raises:
            RuntimeError: ``stop`` has begun.
        """
        work: asyncio.Task[Any] | None = None
        canceled = False

        async def run() -> T:
            nonlocal work
            if canceled:
                coro.close()
                raise asyncio.CancelledError()
            work = asyncio.current_task()
            return await coro

        def cancel() -> None:
            nonlocal canceled
            canceled = True
            if work is not None:
                work.cancel()

        try:
            result = asyncio.wrap_future(self._schedule(run()))
        except RuntimeError:
            coro.close()
            raise
        try:
            return await asyncio.shield(result)
        except asyncio.CancelledError:
            self.loop.call_soon_threadsafe(cancel)
            try:
                await settle(result)
            except Exception:
                logger.debug(
                    "workspace call failed during cancellation", exc_info=True
                )
            raise

    async def stop(self, *, delete: bool = False) -> None:
        """Close the workspace and shut down the runner cleanly.

        Refuses new work, calls ``self.ws.close()`` on the workspace
        loop (``delete()`` when ``delete`` is set), then stops the loop
        and joins the thread. Idempotent; concurrent calls are
        deduplicated.

        Args:
            delete (bool): delete the workspace's state as it closes.
        """
        if self._stopping is None:
            self._stopped = True
            self._stopping = asyncio.ensure_future(self._stop(delete))
        await asyncio.shield(self._stopping)

    async def _stop(self, delete: bool) -> None:
        if not self._thread.is_alive():
            return
        failure: Exception | None = None
        try:
            await asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(
                    self.ws.delete() if delete else self.ws.close(), self.loop
                )
            )
        except Exception as exc:
            if delete:
                failure = exc
            else:
                logger.exception(
                    "workspace close raised during runner shutdown"
                )
        self.loop.call_soon_threadsafe(self.loop.stop)
        await asyncio.to_thread(self._thread.join)
        self.loop.close()
        if failure is not None:
            # A delete that failed left state behind, which the caller
            # has to hear about; a close that failed is shutdown noise.
            raise failure
