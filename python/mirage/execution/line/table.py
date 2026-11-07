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

from collections.abc import Callable

from mirage.execution.constants import HISTORY_MAX_RECORDS, HISTORY_SECONDS
from mirage.execution.line.handle import LineHandle
from mirage.execution.line.types import Line
from mirage.execution.types import LineId
from mirage.utils.clock import Clock, SystemClock


class LineTable:
    """The lines a workspace's sessions read, each from its reading on:
    the ones running, and the newest ended ones, ``HISTORY_MAX_RECORDS``
    of them for ``HISTORY_SECONDS`` at most.

    Only a line its session's shell reads is one; what a line evaluates
    in turn (``$( )``, ``eval``, ``source``) runs within it.
    """

    def __init__(
        self,
        clock: Clock | None = None,
        note: Callable[[Line], None] | None = None,
    ) -> None:
        """Args:
        clock (Clock | None): the workspace clock ended lines age on;
            None is the system clock.
        note (Callable[[Line], None] | None): told each line's record
            as it is read and each time it changes, as the workspace's
            store keeps it.
        """
        self.clock: Clock = clock if clock is not None else SystemClock()
        self._note = note
        self._lines: dict[LineId, LineHandle] = {}

    def start(self, line: LineHandle) -> None:
        """Track a line from its reading on.

        Args:
            line (LineHandle): the line.
        """
        self._prune()
        self._lines[line.id] = line
        if self._note is not None:
            line.noted = self._note
            self._note(line.record)

    def get(self, line_id: LineId) -> Line | None:
        """A line's record, while the table keeps it.

        Args:
            line_id (LineId): the line.
        """
        self._prune()
        line = self._lines.get(line_id)
        return line.record if line is not None else None

    def lines(self, session_id: str | None = None) -> list[Line]:
        """The records the table keeps, oldest first, a session's when
        one is named.

        Args:
            session_id (str | None): the session, or None for all.
        """
        self._prune()
        return [
            line.record
            for line in list(self._lines.values())
            if session_id is None or line.record.session_id == session_id
        ]

    def _prune(self) -> None:
        ended = sorted(
            (
                line
                for line in self._lines.values()
                if line.record.ended_at is not None
            ),
            key=lambda line: line.record.ended_at or 0,
        )
        cutoff = self.clock.now() - HISTORY_SECONDS
        excess = len(ended) - HISTORY_MAX_RECORDS
        for index, line in enumerate(ended):
            if index >= excess and (line.record.ended_at or 0) > cutoff:
                break
            del self._lines[line.id]
