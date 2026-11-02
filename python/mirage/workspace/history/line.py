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


from collections.abc import Awaitable, Callable, Sequence

from mirage.io import IOResult
from mirage.observe.observer import Observer
from mirage.observe.record import OpRecord
from mirage.shell.console import JobConsole, Terminal
from mirage.shell.types import TSNodeLike
from mirage.workspace.history.entries import history_entries
from mirage.workspace.history.types import HistoryEntry
from mirage.workspace.session.session import SessionState


class LineHistory:
    """A typed line's history, recorded as bash's line reader adds it: an
    entry per command the line reads, each with what it wrote to the
    terminal and the status it left, where a line of one command is
    recorded whole. The line's root program reaches each command as it
    runs it (``reach``), and the line's end ends the last (``end``). A line
    answered before its tree runs, or run whole on a runtime (``typed``),
    is recorded once, as typed. Input the root reads again (``read_on``)
    goes on with the root it is read as. Mirrors TypeScript's LineHistory.

    Args:
        observer (Observer): the workspace's observer.
        command (str): the line as typed.
        root (TSNodeLike): the parsed line.
        entries (list[HistoryEntry]): the line's entries.
        session_id (str): the session the line is recorded under.
        session (SessionState): the session the line runs on, whose cwd
            its entries name.
        line_id (str | None): the line's execution id, its first entry's.
        terminal (Terminal): where the line writes.
    """

    def __init__(
        self,
        observer: Observer,
        command: str,
        root: TSNodeLike,
        entries: list[HistoryEntry],
        session_id: str,
        session: SessionState,
        line_id: str | None,
        terminal: Terminal,
    ) -> None:
        self._root = root
        self._shift = 0
        self._next: int | None = None
        self._observer = observer
        self._command = command
        self._entries = entries
        self._session_id = session_id
        self._session = session
        self._id = line_id
        self._terminal = terminal
        self._current = -1
        self._opened = 0
        self._line: str | None = None
        self._ops = 0
        self._whole = False
        self._through = False
        self._done = False

    @classmethod
    def open(
        cls,
        observer: Observer,
        command: str,
        root: TSNodeLike,
        session_id: str,
        session: SessionState,
        line_id: str | None,
        sink: JobConsole | None,
    ) -> "LineHistory | None":
        """The history of a line whose input bash's reader reads as more
        than one entry, written to a terminal; None for any other line,
        which the line records whole as it starts.

        Args:
            observer (Observer): the workspace's observer.
            command (str): the line as typed.
            root (TSNodeLike): the parsed line.
            session_id (str): the session the line is recorded under.
            session (SessionState): the session the line runs on.
            line_id (str | None): the line's execution id.
            sink (JobConsole | None): where the line writes.
        """
        if not isinstance(sink, Terminal):
            return None
        entries = history_entries(root)
        if len(entries) < 2:
            return None
        return cls(
            observer,
            command,
            root,
            entries,
            session_id,
            session,
            line_id,
            sink,
        )

    def reads(self, node: TSNodeLike) -> bool:
        """Whether ``node``'s program reads the line: the line's root, or
        the first root to run once its input is read again (``read_on``),
        which takes over.

        Args:
            node (TSNodeLike): a program about to run its statements.
        """
        if node is self._root:
            return True
        if self._next is None or node.parent is not None:
            return False
        self._root = node
        self._shift = self._next
        self._next = None
        return True

    async def read_on(
        self, at: int, run: Callable[[], Awaitable[IOResult]]
    ) -> IOResult:
        """Read the root's input again from a statement on, as a root of
        its own that ``run`` parses and runs.

        Args:
            at (int): where, in the root's input, the input read again
                starts: the statement's index less the blank rows put
                ahead of it.
            run (Callable[[], Awaitable[IOResult]]): reads it.
        """
        self._next = self._shift + at
        try:
            return await run()
        finally:
            self._next = None

    async def reach(
        self,
        child: TSNodeLike,
        session: SessionState,
        records: Sequence[OpRecord],
    ) -> None:
        """Reach the command the root program runs next: end the entry
        before it and record the entries up to it, its own last.

        Args:
            child (TSNodeLike): the root's statement about to run.
            session (SessionState): the shell running it, whose ``$?``
                ends the entry before.
            records (Sequence[OpRecord]): the line's op records so far, of
                which the entry before's are those since the one before it
                ended.
        """
        if self._whole or self._done:
            return
        offsets = getattr(self._root, "offsets", None) or ()
        start = child.start_byte
        at = self._shift + (offsets[start] if start < len(offsets) else start)
        reached = self._current
        for j in range(self._current + 1, len(self._entries)):
            entry_at = self._entries[j].at
            if entry_at is not None and entry_at > at:
                break
            if entry_at is not None:
                reached = j
        if reached <= self._current:
            return
        status = IOResult(exit_code=session.last_exit_code)
        await self._close(status, records)
        for j in range(self._current + 1, reached):
            await self._begin(self._entries[j].text)
            await self._close(status, records)
        self._current = reached
        await self._begin(self._entries[reached].text)

    def read(self) -> None:
        """The root program read the input to its end, so the entries
        after its last command are read too."""
        self._through = True

    async def typed(self) -> None:
        """Record the line once, as typed, before it runs whole on a
        runtime."""
        if self._current >= 0 or self._whole:
            return
        self._whole = True
        await self._begin(self._command)

    async def end(self, io: IOResult, records: Sequence[OpRecord]) -> None:
        """End the line: its last entry, with what the line wrote since and
        what it answered with besides, or, when no command was reached, the
        line as typed, unless its root read it through. A line ends once.

        Args:
            io (IOResult): the line's result.
            records (Sequence[OpRecord]): the line's op records, of which
                the last entry's are those since the entry before ended.
        """
        if self._done:
            return
        if self._current < 0 and not self._through:
            await self.typed()
        await self._close(io, records)
        self._done = True
        if not self._through or self._whole:
            return
        status = IOResult(exit_code=io.exit_code)
        for j in range(self._current + 1, len(self._entries)):
            await self._begin(self._entries[j].text)
            await self._close(status, records)

    async def _begin(self, text: str) -> None:
        self._line = (
            self._id
            if self._opened == 0 or self._id is None
            else f"{self._id}.{self._opened}"
        )
        self._opened += 1
        await self._observer.log_command(
            text, self._session_id, self._session.cwd, self._line
        )

    async def _close(self, io: IOResult, records: Sequence[OpRecord]) -> None:
        if self._opened == 0:
            return
        stdout, stderr = self._terminal.entry()
        await self._observer.log_result(
            IOResult(
                stdout=stdout + await io.materialize_stdout(),
                stderr=stderr + await io.materialize_stderr(),
                exit_code=io.exit_code,
            ),
            list(records[self._ops :]),
            self._session_id,
            self._session.cwd,
            self._line,
        )
        self._ops = len(records)
