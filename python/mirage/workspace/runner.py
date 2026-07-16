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
import threading
from typing import Any, Coroutine, TypeVar

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
    asyncio loop.

    Example:

        ws = Workspace({"/": (RAMResource(), MountMode.WRITE)})
        runner = WorkspaceRunner(ws)
        try:
            result = await runner.call(runner.ws.execute("ls /"))
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
        self._ready = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name=f"mirage-ws-{id(ws):x}",
            daemon=True,
        )
        self._thread.start()
        self._ready.wait()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.call_soon(self._ready.set)
        self.loop.run_forever()

    async def call(self, coro: Coroutine[Any, Any, T]) -> T:
        """Run ``coro`` on the workspace loop and await the result.

        Safe to call from any other event loop. The current loop is
        not blocked while the workspace loop processes ``coro``.

        Args:
            coro (Awaitable[T]): a coroutine produced from the
                workspace's API, e.g. ``runner.ws.execute("ls /")``.

        Returns:
            T: whatever ``coro`` resolves to.
        """
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return await asyncio.wrap_future(fut)

    def call_sync(self,
                  coro: Coroutine[Any, Any, T],
                  timeout: float | None = None) -> T:
        """Run ``coro`` on the workspace loop and block until done.

        Use from synchronous callers (tests, blocking scripts). Do
        NOT use from inside another running event loop -- that will
        deadlock the caller's loop. Use :meth:`call` from there.

        Args:
            coro (Awaitable[T]): the workspace coroutine to run.
            timeout (float | None): seconds to wait, or None for no
                limit.

        Returns:
            T: whatever ``coro`` resolves to.
        """
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return fut.result(timeout=timeout)

    async def stop(self) -> None:
        """Close the workspace and shut down the runner cleanly.

        Calls ``self.ws.close()`` on the workspace loop, then stops
        the loop and joins the thread. Idempotent.
        """
        if not self._thread.is_alive():
            return
        try:
            await self.call(self.ws.close())
        except Exception:
            logger.exception("workspace close raised during runner shutdown")
        self.loop.call_soon_threadsafe(self.loop.stop)
        await asyncio.to_thread(self._thread.join)
        self.loop.close()
