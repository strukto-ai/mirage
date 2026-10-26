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

import json
import logging
from dataclasses import replace
from typing import Any

from mirage.context.session_context import current_execution_id
from mirage.io.types import IOResult
from mirage.observe.log_entry import (
    EVENT_CLEAR,
    EVENT_COMMAND,
    EVENT_DELETE,
    EVENT_OP,
    STDOUT_TRUNCATE,
    LogEntry,
)
from mirage.observe.record import OpRecord
from mirage.observe.store import ObserverStore, RAMObserverStore
from mirage.utils.clock import Clock, SystemClock
from mirage.utils.dates import utc_date_folder

logger = logging.getLogger(__name__)


def _parse_files(files: dict[str, bytes]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key in sorted(files.keys()):
        if not key.endswith(".jsonl"):
            continue
        for line in files[key].decode(errors="replace").splitlines():
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                # A crash mid-append leaves half a line; drop it, not
                # every later read of the session's history.
                logger.debug("skipping torn history line in %s", key)
    return out


def _newest_stamp(events: list[dict[str, Any]]) -> int | None:
    """The latest timestamp among ``events``, None when none carries one.

    Args:
        events (list[dict[str, Any]]): parsed LogEntry dicts.
    """
    return max(
        (
            int(stamp)
            for e in events
            if isinstance(stamp := e.get("timestamp"), (int, float))
        ),
        default=None,
    )


def _later(a: int | None, b: int | None) -> int | None:
    """The later of two stamps, either of which may be absent.

    Args:
        a (int | None): a stamp, or None.
        b (int | None): a stamp, or None.
    """
    return b if a is None else a if b is None else max(a, b)


class Observer:
    """Persists LogEntry records to an ObserverStore as JSONL files.

    The hidden recorder: it owns no mount and its store is reachable
    only through this class, so the log is invisible to agents. Views
    (/.bash_history, the history builtin) render from the query
    methods below; swapping infra (RAM, Redis, disk, opfs) means
    passing a different store, nothing above this seam changes.

    Every entry is stamped, and filed under its day, on ``clock``: the
    workspace's, which also stamps the op records the entries carry, so
    a workspace on a manual clock keeps one time domain in its history.
    No entry is stamped before the newest one its session holds: a clock
    that restarts behind stored history (a fresh ``ManualClock`` over a
    restored or persisted log) would otherwise file a clear or delete
    ahead of the commands it acts on. A session with no history sets no
    floor.

    Args:
        store (ObserverStore | None): Storage backend for log files;
            defaults to an in-memory RAMObserverStore.
        clock (Clock | None): the workspace clock; None is the system
            clock.
    """

    def __init__(
        self, store: ObserverStore | None = None, clock: Clock | None = None
    ) -> None:
        self._store = store if store is not None else RAMObserverStore()
        self._clock: Clock = clock if clock is not None else SystemClock()
        self._newest: dict[str, int | None] = {}

    def _now_ms(self) -> int:
        """The clock's wall time in epoch milliseconds, an entry's stamp."""
        return int(self._clock.now() * 1000)

    @property
    def store(self) -> ObserverStore:
        return self._store

    async def _floor(self, session: str) -> int | None:
        """The newest stamp ``session`` holds, None when it holds none.

        Read once per session, from that session's files only (the
        files its history view reads); an entry stamped while they are
        read is newer still and is kept.

        Args:
            session (str): the session the next entry belongs to.
        """
        if session not in self._newest:
            files = await self._store.read_matching(f"/{session}.jsonl")
            found = _newest_stamp(_parse_files(files))
            self._newest[session] = _later(found, self._newest.get(session))
        return self._newest[session]

    async def _log(self, entry: LogEntry) -> None:
        floor = await self._floor(entry.session)
        if floor is not None and entry.timestamp < floor:
            entry = replace(entry, timestamp=floor)
        self._newest[entry.session] = entry.timestamp
        line = (entry.to_json_line() + "\n").encode()
        day = utc_date_folder(entry.timestamp / 1000)
        await self._store.append(f"/{day}/{entry.session}.jsonl", line)

    async def log_op(
        self,
        rec: OpRecord,
        session: str,
        cwd: str | None = None,
    ) -> None:
        """Persist an OpRecord as a JSONL line.

        Args:
            rec (OpRecord): The operation record.
            session (str): Session ID.
            cwd (str | None): Session cwd at log time.
        """
        await self._log(LogEntry.from_op_record(rec, session, cwd))

    async def log_execution(
        self,
        command: str,
        io: IOResult,
        op_records: list[OpRecord],
        session: str,
        cwd: str | None = None,
    ) -> None:
        """Record one finished typed line: its ops, then its command.

        The line reader's single recording call: every op the line
        emitted lands first, then the command entry itself.

        Args:
            command (str): The typed line, verbatim and unexpanded.
            io (IOResult): Final result of the line.
            op_records (list[OpRecord]): Ops collected while it ran.
            session (str): Session the line ran in.
            cwd (str | None): Session cwd at completion.
        """
        # TODO: batch the op lines and the command line into a single
        # store.append so one typed line costs one roundtrip and lands
        # atomically in the store.
        for rec in op_records:
            await self.log_op(rec, session, cwd)
        stdout = await io.materialize_stdout()
        await self._log(
            LogEntry(
                type=EVENT_COMMAND,
                session=session,
                timestamp=self._now_ms(),
                cwd=cwd,
                command=command,
                exit_code=io.exit_code,
                stdout=stdout.decode(errors="replace")[:STDOUT_TRUNCATE],
                execution_id=current_execution_id(),
            )
        )

    async def log_command_text(
        self,
        command: str,
        session: str,
        cwd: str | None = None,
    ) -> None:
        """Append a command entry without an execution (history -s).

        Args:
            command (str): Command text to record as a single entry.
            session (str): Session ID the entry belongs to.
            cwd (str | None): Session cwd at append time.
        """
        await self._log(
            LogEntry(
                type=EVENT_COMMAND,
                session=session,
                timestamp=self._now_ms(),
                cwd=cwd,
                command=command,
                exit_code=0,
            )
        )

    async def log_clear(self, session: str) -> None:
        """Append a clear tombstone for a session (history -c).

        Args:
            session (str): Session ID whose history view is cleared.
        """
        await self._log(
            LogEntry(
                type=EVENT_CLEAR,
                session=session,
                timestamp=self._now_ms(),
            )
        )

    async def log_delete(self, session: str, offset: int) -> None:
        """Append a delete event for one listing entry (history -d).

        Args:
            session (str): Session ID whose entry is deleted.
            offset (int): 1-based listing position; negative counts
                back from the end at the time of the delete.
        """
        await self._log(
            LogEntry(
                type=EVENT_DELETE,
                session=session,
                timestamp=self._now_ms(),
                offset=offset,
            )
        )

    async def events(self) -> list[dict[str, Any]]:
        """All recorded events across sessions, in timestamp order.

        Timestamps are UTC epoch milliseconds. The sort is stable over
        the per-file line order, so events that share a millisecond
        (one line's ops plus its command entry) keep the order they
        were appended in; append order within a session file is the
        contract.

        Returns:
            list[dict]: Parsed LogEntry dicts.
        """
        out = _parse_files(await self._store.read_all())
        out.sort(key=lambda e: e.get("timestamp", 0))
        return out

    async def command_events(self) -> list[dict[str, Any]]:
        """Command events across all sessions, in append order.

        Returns:
            list[dict]: Events with type == EVENT_COMMAND.
        """
        return [
            e for e in await self.events() if e.get("type") == EVENT_COMMAND
        ]

    async def session_command_events(
        self, session: str
    ) -> list[dict[str, Any]]:
        """One session's visible history listing, append order.

        Projects the session's events: commands after the last clear
        tombstone, with delete events applied at the position they
        were issued (history -d renumbers subsequent entries, GNU
        behavior).

        Args:
            session (str): Session ID to project.

        Returns:
            list[dict]: Events with type == EVENT_COMMAND.
        """
        files = await self._store.read_matching(f"/{session}.jsonl")
        entries = _parse_files(files)
        last_clear = -1
        for i, e in enumerate(entries):
            if e.get("type") == EVENT_CLEAR:
                last_clear = i
        visible: list[dict[str, Any]] = []
        for e in entries[last_clear + 1 :]:
            kind = e.get("type")
            if kind == EVENT_COMMAND:
                visible.append(e)
            elif kind == EVENT_DELETE:
                offset = e.get("offset", 0)
                idx = offset - 1 if offset > 0 else len(visible) + offset
                if 0 <= idx < len(visible):
                    visible.pop(idx)
        return visible

    async def load_events(self, events: list[dict[str, Any]]) -> None:
        """Rewind the recorder to a snapshot's events.

        Clears the store first, mirroring ``ws._cache.clear()`` on the
        checkout path: restoring means becoming the snapshot, so
        events from the pre-restore timeline (including sessions the
        snapshot doesn't know about) do not survive. Events are
        rewritten per session under today's date folder (or the newest
        event's, when the clock stands behind it), preserving
        their list order as line order; original date folders are not
        preserved, which the views never depend on (they filter by
        the session field).

        Foreign-format entries (e.g. the TypeScript snapshot's
        ExecutionRecord history, which has no ``type`` field and may
        carry a non-JSON ``stdout``) are skipped: the views filter by
        ``type`` so they are unusable here anyway, and keeping them
        would break re-serialization. The TS loader skips Python's
        entries symmetrically until the history port lands.

        Args:
            events (list[dict]): LogEntry dicts from StateKey.HISTORY.
        """
        await self._store.clear()
        known = (EVENT_COMMAND, EVENT_CLEAR, EVENT_DELETE, EVENT_OP)
        newest = _newest_stamp([e for e in events if e.get("type") in known])
        written = (
            self._now_ms() if newest is None else max(self._now_ms(), newest)
        )
        day = utc_date_folder(written / 1000)
        by_session: dict[str, list[str]] = {}
        for e in events:
            if e.get("type") not in known:
                continue
            session = e.get("session", "default")
            by_session.setdefault(session, []).append(
                json.dumps(e, separators=(",", ":"))
            )
        self._newest = {session: written for session in by_session}
        for session, lines in by_session.items():
            await self._store.write(
                f"/{day}/{session}.jsonl", ("\n".join(lines) + "\n").encode()
            )
