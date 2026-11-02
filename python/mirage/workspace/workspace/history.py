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


from collections.abc import Sequence
from dataclasses import dataclass

from mirage.io import IOResult
from mirage.observe.context import active_records
from mirage.observe.observer import Observer
from mirage.observe.record import OpRecord
from mirage.shell.bytes import decode_text
from mirage.shell.console import JobConsole, Terminal
from mirage.shell.helpers import same_line
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.workspace.session.session import SessionState

WORDS = frozenset(
    {
        NT.STRING,
        NT.RAW_STRING,
        NT.ANSI_C_STRING,
        NT.TRANSLATED_STRING,
        NT.COMMAND_SUBSTITUTION,
        NT.ARITHMETIC_EXPANSION,
        NT.PROCESS_SUBSTITUTION,
        NT.EXPANSION,
    }
)
"""The words a line break inside of stays in an entry as typed."""

OPENERS = frozenset(
    {
        "then",
        "do",
        "else",
        "elif",
        "if",
        "while",
        "until",
        "{",
        "(",
        "in",
        "|",
        "|&",
        "||",
        "&&",
        ";",
        ";;",
        ";&",
        ";;&",
        "&",
        "!",
        "case",
        "for",
        "select",
        "function",
        "time",
    }
)
"""The tokens a command reads on after, so a line break after one joins
as a space."""


@dataclass(frozen=True)
class HistoryEntry:
    """One entry bash's history adds for an input it reads.

    Args:
        text (str): the entry, its lines joined as ``cmdhist`` joins them.
        at (int | None): where its first command starts in the text the
            tree reads; None for a line of blanks.
    """

    text: str
    at: int | None


def _descendants(node: TSNodeLike) -> list[TSNodeLike]:
    return [node, *(d for c in node.children for d in _descendants(c))]


def history_entries(root: TSNodeLike) -> list[HistoryEntry]:
    """The entries bash's history adds for an input it reads
    interactively: one per command it reads, a command and what else is on
    the line it ends on. A command spanning lines is one entry, its lines
    joined as ``cmdhist`` joins them: a break inside a quoted word, a
    substitution or a heredoc stays, a backslash's goes, and any other is
    a ``; `` or, after a token a command reads on after (``then``, ``|``,
    ``{``, a case pattern's ``)``), a space. A comment line inside a
    command is dropped, a line of blanks is an entry of its own and an
    empty line none. Pinned against Debian Bash 5.2.37 with ``set +H``.
    Mirrors TypeScript's historyEntries.

    Args:
        root (TSNodeLike): the parsed input.
    """
    text_read: bytes = root.text or b""
    source: bytes = getattr(root, "source_text", None) or text_read
    base = root.start_byte
    offsets: Sequence[int] = getattr(root, "offsets", None) or ()

    def typed(index: int) -> int:
        return offsets[index] if index < len(offsets) else index

    breaks = {
        typed(base + i): base + i
        for i, byte in enumerate(text_read)
        if byte == 0x0A
    }
    groups: list[list[TSNodeLike]] = []
    for child in root.children:
        if not child.is_named:
            continue
        if groups and same_line(root, groups[-1][-1], child):
            groups[-1].append(child)
        else:
            groups.append([child])
    entries: list[HistoryEntry] = []
    read = 0
    for group in groups:
        first = group[0]
        nodes = [d for n in group for d in _descendants(n)]
        folded = [
            (n, doc)
            for n in nodes
            if (doc := getattr(n, "heredoc", None)) is not None
        ]

        def inside(node: TSNodeLike) -> bool:
            return any(
                n.start_byte <= node.start_byte and node.end_byte <= n.end_byte
                for n, _ in folded
            )

        start = source.rfind(b"\n", 0, max(0, typed(first.start_byte))) + 1
        end = max(
            [
                typed(n.end_byte - 1) + 1
                for n in nodes
                if not n.children and not inside(n)
            ]
            + [doc.end for _, doc in folded]
        )
        found = source.find(b"\n", end - 1)
        stop = len(source) if found < 0 else found
        for row in source[read:start].split(b"\n"):
            if row and not row.strip():
                entries.append(HistoryEntry(decode_text(row), None))
        read = stop + 1
        if any(n.type == NT.ERROR for n in nodes):
            entries.append(
                HistoryEntry(decode_text(source[start:stop]), first.start_byte)
            )
            continue
        comments = {typed(n.start_byte) for n in nodes if n.type == NT.COMMENT}

        def within(index: int) -> bool:
            return any(
                n.type in WORDS and n.start_byte < index < n.end_byte
                for n in nodes
            )

        def joint(at: int) -> bytes:
            docs = [
                (n, doc) for n, doc in folded if doc.word_end <= at < doc.end
            ]
            if docs:
                if not all(at == doc.end - 1 for _, doc in docs):
                    return b"\n"
                if any(within(n.start_byte) for n, _ in docs):
                    return b"\n\n"
                return b"\n "
            index = breaks.get(at)
            if index is None:
                before = base
                for i in range(base, base + len(text_read)):
                    if typed(i) < at - 1:
                        before = i
                if within(before) or source[at - 1] != 0x5C:
                    return b"\n"
                return b""
            if within(index):
                return b"\n"
            if any(
                n.type == NT.ARRAY and n.start_byte < index < n.end_byte
                for n in nodes
            ):
                return b" "
            leaf: TSNodeLike | None = None
            for n in nodes:
                if (
                    not n.children
                    and n.end_byte <= index
                    and (leaf is None or n.end_byte >= leaf.end_byte)
                ):
                    leaf = n
            if leaf is None:
                return b"; "
            if leaf.type == NT.COMMENT:
                return b"\n"
            if not leaf.is_named and leaf.type in OPENERS:
                return b" "
            pattern = leaf.parent.type if leaf.parent is not None else None
            if leaf.type == ")" and pattern in (
                NT.CASE_ITEM,
                NT.FUNCTION_DEFINITION,
            ):
                return b" "
            return b"; "

        text = b""
        blank = False
        comment = False
        at = start
        while True:
            following = source.find(b"\n", at)
            ends = stop if following < 0 or following > stop else following
            row = source[at:ends]
            if at == start:
                text = row
            else:
                between = joint(at - 1)
                word = between.startswith(b"\n")
                if not word and at + len(row) - len(row.lstrip()) in comments:
                    comment = True
                else:
                    if comment:
                        joined = b"\n"
                    elif blank and not word:
                        joined = b" "
                    else:
                        joined = between
                    text = (
                        (text[:-1] if between == b"" else text) + joined + row
                    )
                    blank = not word and not row.strip()
                    comment = False
            if ends >= stop:
                break
            at = ends + 1
        if any(doc.end - 1 == stop for _, doc in folded):
            text += b"\n"
        entries.append(HistoryEntry(decode_text(text), first.start_byte))
    return entries


class LineHistory:
    """A typed line's history, recorded as bash's line reader adds it: an
    entry per command the line reads, each with what it wrote to the
    terminal and the status it left, where a line of one command is
    recorded whole. The line's root program reaches each command as it
    runs it (``reach``), and the line's end ends the last (``end``). A line
    answered before its tree runs, or run whole on a runtime (``typed``),
    is recorded once, as typed. Mirrors TypeScript's LineHistory.

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
        self.root = root
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

    async def reach(self, child: TSNodeLike, session: SessionState) -> None:
        """Reach the command the root program runs next: end the entry
        before it and record the entries up to it, its own last.

        Args:
            child (TSNodeLike): the root's statement about to run.
            session (SessionState): the shell running it, whose ``$?``
                ends the entry before.
        """
        if self._whole or self._done:
            return
        at = child.start_byte
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
        records = list(active_records() or [])
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
        line as typed. A line ends once.

        Args:
            io (IOResult): the line's result.
            records (Sequence[OpRecord]): the line's op records, of which
                the last entry's are those since the entry before ended.
        """
        if self._done:
            return
        if self._current < 0:
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
