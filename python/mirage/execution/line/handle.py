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
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace

from mirage.execution.line.types import Line, LineState
from mirage.execution.types import LineId
from mirage.io.yield_budget import YieldBudget
from mirage.utils.abort import MirageAbortError


class LineHandle:
    """One line as the workspace running it holds it: its record, the
    yield budget the line and its evaluations share, and its admission.

    The record moves on as the line does (``start``, ``stop``, ``end``),
    from whichever loop runs it: a server answers with the line's id
    before its workspace reads it, and reads the record from its own.
    """

    def __init__(
        self,
        line_id: LineId,
        session_id: str,
        command: str,
        on_start: Callable[[], Awaitable[None]] | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        """Args:
        line_id (LineId): the line's id.
        session_id (str): the session it runs on.
        command (str): its text.
        on_start (Callable[[], Awaitable[None]] | None): run once the
            session admits it, before any effect; one that raises keeps
            the line from running.
        now (Callable[[], float]): the clock its times are read on.
        """
        self._now = now
        self._record = Line(line_id, session_id, command, now())
        self._budget = YieldBudget()
        self._on_start = on_start
        self._stop_signal: int | None = None

    @property
    def id(self) -> LineId:
        return self._record.id

    @property
    def record(self) -> Line:
        """The line as its record reads now."""
        return self._record

    async def start(self) -> None:
        """Publish admission once, after acquiring the session and
        before effects; the line runs from then on."""
        if self._on_start is not None:
            on_start, self._on_start = self._on_start, None
            await on_start()
        if self._record.state == LineState.WAITING:
            self._record = replace(self._record, state=LineState.RUNNING)

    async def checkpoint(self, cancel: asyncio.Event | None = None) -> None:
        if cancel is not None and cancel.is_set():
            raise MirageAbortError()
        await self._budget.run()
        if cancel is not None and cancel.is_set():
            raise MirageAbortError()

    def stop(self, signal: int) -> None:
        """Mark the line stopping: it ends as stopped by ``signal``,
        however it then ends.

        Args:
            signal (int): the signal the stop stands for.
        """
        if self._record.ended_at is not None:
            return
        self._stop_signal = signal
        self._record = replace(self._record, state=LineState.STOPPING)

    def end(self, exit: int | None, error: str | None = None) -> None:
        """End the line, once: a later call changes nothing.

        Args:
            exit (int | None): its status, None when it has none.
            error (str | None): why Mirage could not run it, if it
                could not.
        """
        if self._record.ended_at is not None:
            return
        self._record = replace(
            self._record,
            state=LineState.EXITED,
            ended_at=self._now(),
            exit=exit,
            signal=self._stop_signal,
            error=error,
        )
