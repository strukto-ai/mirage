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
from collections.abc import Awaitable, Callable

import anyio

from mirage.concurrency.limiter import settle
from mirage.execution.constants import LINE_STOP_SIGNAL
from mirage.execution.context import new_line_id
from mirage.execution.line.handle import LineHandle
from mirage.execution.line.types import LineState
from mirage.execution.types import LineId
from mirage.types import JsonValue
from mirage.utils.abort import MirageAbortError

logger = logging.getLogger(__name__)


class LineRequest:
    """One request that runs a line: the line's handle, the work running
    it, and what the request answers once it settles: its result, or the
    error that failed it.

    The line's record says how the line went (``LineHandle``); a request
    whose line ended may still fail after, should its answer not be
    made.
    """

    def __init__(self, line: LineHandle, workspace_id: str) -> None:
        """Args:
        line (LineHandle): the request's line.
        workspace_id (str): the workspace it runs in.
        """
        self.line = line
        self.workspace_id = workspace_id
        self.result: JsonValue = None
        self.error: str | None = None
        self.cancel_requested = False
        self.work: asyncio.Task[JsonValue] | None = None
        self.completion: asyncio.Task[None] | None = None
        self.settled = asyncio.Event()

    @property
    def id(self) -> LineId:
        return self.line.id


class RequestTable:
    """The server's requests that run a line, each by its line's id,
    until its caller has its answer.

    A line runs only after its session admits it. Cancel stops the work
    at once; the line ends as stopped by an interrupt after the work and
    its cleanup settle, unless it ended first. A request is held until
    ``wait`` hands it to its caller, or its workspace goes.
    """

    def __init__(self) -> None:
        self._requests: dict[LineId, LineRequest] = {}
        # Set once the server starts shutting down: every door that
        # submits a line refuses a new one.
        self.draining = False
        self._closed = False
        self._closing: asyncio.Task[None] | None = None

    def requests(self) -> list[LineRequest]:
        """The requests held, as of now, read off the server's loop too."""
        return list(self._requests.values())

    def discard_workspace(self, workspace_id: str) -> None:
        """Forget requests after their workspace's runner has stopped.

        Args:
            workspace_id (str): the deleted workspace.
        """
        self._requests = {
            line_id: request
            for line_id, request in self._requests.items()
            if request.workspace_id != workspace_id
        }

    async def _started(self, line_id: LineId) -> None:
        request = self._requests.get(line_id)
        if request is not None and request.cancel_requested:
            raise asyncio.CancelledError()

    def submit(
        self,
        workspace_id: str,
        command: str,
        factory: Callable[[LineHandle], Awaitable[JsonValue]],
        *,
        session_id: str,
    ) -> LineRequest:
        """Start a request's line.

        Args:
            workspace_id (str): the workspace it runs in.
            command (str): the line.
            factory (Callable[[LineHandle], Awaitable[JsonValue]]): runs
                the line and makes the request's answer.
            session_id (str): the session it runs on.
        """
        if self._closed:
            raise RuntimeError("request table is closed")
        owner = asyncio.get_running_loop()
        line_id = new_line_id()

        async def started() -> None:
            await asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(self._started(line_id), owner)
            )

        request = LineRequest(
            LineHandle(line_id, session_id, command, on_start=started),
            workspace_id,
        )
        self._requests[line_id] = request
        request.completion = asyncio.create_task(self._run(request, factory))
        return request

    async def _run(
        self,
        request: LineRequest,
        factory: Callable[[LineHandle], Awaitable[JsonValue]],
    ) -> None:
        line = request.line
        try:
            if request.cancel_requested:
                raise asyncio.CancelledError()
            request.work = asyncio.ensure_future(factory(line))
            request.result = await request.work
        except (asyncio.CancelledError, MirageAbortError):
            # The request's own cancel arrives as CancelledError; the
            # workspace's (a session or workspace cancel) as the abort
            # the line raised.
            line.stop(LINE_STOP_SIGNAL)
        except Exception as exc:
            request.error = f"{type(exc).__name__}: {exc}"
        if request.cancel_requested:
            line.stop(LINE_STOP_SIGNAL)
        stopped = (
            line.record.state == LineState.STOPPING
            or line.record.signal is not None
        )
        if stopped:
            request.result = None
        line.end(128 + LINE_STOP_SIGNAL if stopped else None, request.error)
        request.settled.set()

    async def wait(self, line_id: LineId) -> LineRequest:
        """A request once it settles, which the table then lets go.

        Args:
            line_id (LineId): the request's line.
        """
        request = self._requests[line_id]
        await request.settled.wait()
        self._requests.pop(line_id, None)
        return request

    async def join(self, line_id: LineId) -> LineRequest:
        """Wait for a request on behalf of the caller that made it.

        A caller cancelled while it waits cancels the request and waits
        for its cleanup before giving up, so the work never outlives the
        request that started it.

        Args:
            line_id (LineId): the request's line.
        """
        try:
            return await self.wait(line_id)
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                self.cancel(line_id)
                await self.drain(line_id)
            raise

    def cancel(self, line_id: LineId) -> bool:
        """Stop a request's work and mark its line stopping.

        Args:
            line_id (LineId): the request's line.

        Returns:
            bool: whether this call cancelled the request; False for one
            already settled, or settled and let go.
        """
        request = self._requests.get(line_id)
        if (
            request is None
            or request.settled.is_set()
            or request.cancel_requested
        ):
            return False
        request.cancel_requested = True
        request.line.stop(LINE_STOP_SIGNAL)
        if request.work is not None:
            request.work.cancel()
        return True

    async def drain(self, line_id: LineId) -> None:
        """Wait for a request's work and cleanup to settle.

        Args:
            line_id (LineId): the request's line.
        """
        request = self._requests.get(line_id)
        if request is not None and request.completion is not None:
            await settle(request.completion)

    async def close(self) -> None:
        self._closed = True
        if self._closing is None:
            self._closing = asyncio.create_task(self._finish_close())
        await settle(self._closing)

    async def _finish_close(self) -> None:
        requests = list(self._requests.values())
        for request in requests:
            self.cancel(request.id)
        await asyncio.gather(
            *(
                request.completion
                for request in requests
                if request.completion is not None
            )
        )
