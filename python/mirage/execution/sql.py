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
import json
import logging
import threading
import time
import uuid
from collections.abc import Mapping, Sequence

from mirage.concurrency.limiter import run_blocking
from mirage.execution.base import ExecutionStore
from mirage.execution.constants import HISTORY_MAX_RECORDS, HISTORY_SECONDS
from mirage.execution.job.constants import LEASE_SECONDS
from mirage.execution.line.types import Line
from mirage.execution.process.types import Process
from mirage.execution.serde import (
    line_from_fields,
    line_to_fields,
    process_from_fields,
    process_to_fields,
)
from mirage.execution.types import LineId, ProcessId
from mirage.shell.console.sql import SqlConsoleStore
from mirage.vfs.sql.types import (
    SqlDialect,
    SqlDriver,
    SqlRow,
    SqlStatement,
    SqlValue,
)
from mirage.workspace.record.types import RecordFields, generation_of

logger = logging.getLogger(__name__)

# Every statement the sql execution store runs, by name. Mirrors
# TypeScript's ``EXECUTION_SQL``.
EXECUTION_SQL: dict[str, str] = {
    "get": "SELECT fields, generation, ended FROM mirage_execution"
    " WHERE scope = ? AND kind = ? AND name = ?",
    "kind": "SELECT name, fields FROM mirage_execution"
    " WHERE scope = ? AND kind = ?",
    "put": "INSERT INTO mirage_execution"
    " (scope, kind, name, fields, generation, ended)"
    " VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, kind, name)"
    " DO UPDATE SET fields = excluded.fields,"
    " generation = excluded.generation, ended = excluded.ended",
    "insert_new": "INSERT INTO mirage_execution"
    " (scope, kind, name, fields, generation, ended)"
    " VALUES (?, 'list', ?, ?, ?, NULL) ON CONFLICT (scope, kind, name)"
    " DO UPDATE SET fields = excluded.fields,"
    " generation = excluded.generation"
    " WHERE mirage_execution.generation = 0 RETURNING name",
    "update_at": "UPDATE mirage_execution SET fields = ?, generation = ?"
    " WHERE scope = ? AND kind = 'list' AND name = ? AND generation = ?"
    " RETURNING name",
    "delete_at": "DELETE FROM mirage_execution"
    " WHERE scope = ? AND kind = 'list' AND name = ? AND generation = ?"
    " RETURNING fields",
    "lease": "INSERT INTO mirage_execution"
    " (scope, kind, name, fields, generation, ended)"
    " VALUES (?, 'lease', '', ?, 0, ?) ON CONFLICT (scope, kind, name)"
    " DO UPDATE SET fields = excluded.fields, ended = excluded.ended"
    " WHERE mirage_execution.fields = excluded.fields"
    " OR mirage_execution.ended <= ? RETURNING name",
    "release": "DELETE FROM mirage_execution"
    " WHERE scope = ? AND kind = 'lease' AND name = '' AND fields = ?",
    "raise_pid": "INSERT INTO mirage_execution"
    " (scope, kind, name, fields, generation, ended)"
    " VALUES (?, 'pid', '', '{}', ?, NULL) ON CONFLICT (scope, kind, name)"
    " DO UPDATE SET generation = excluded.generation"
    " WHERE mirage_execution.generation < excluded.generation",
    "delete": "DELETE FROM mirage_execution"
    " WHERE scope = ? AND kind = ? AND name = ?",
    "delete_kind": "DELETE FROM mirage_execution WHERE scope = ? AND kind = ?",
    "take_kind": "DELETE FROM mirage_execution WHERE scope = ? AND kind = ?"
    " RETURNING fields, generation",
    "prune": "DELETE FROM mirage_execution"
    " WHERE scope = ? AND kind = ? AND ended IS NOT NULL AND (ended <= ?"
    " OR name NOT IN (SELECT name FROM mirage_execution"
    " WHERE scope = ? AND kind = ? AND ended IS NOT NULL"
    " ORDER BY ended DESC LIMIT ?))",
    "drop_console": "DELETE FROM mirage_console WHERE scope = ? AND name = ?",
    "clear": "DELETE FROM mirage_execution WHERE scope = ?",
    "clear_consoles": "DELETE FROM mirage_console WHERE scope = ?",
}


def _schema(dialect: SqlDialect) -> list[SqlStatement]:
    """The tables the store keeps its rows in, made on first use.

    Args:
        dialect (SqlDialect): the database's dialect, which names the
            byte column's type.
    """
    blob = "BYTEA" if dialect == SqlDialect.POSTGRES else "BLOB"
    return [
        SqlStatement(
            "CREATE TABLE IF NOT EXISTS mirage_execution ("
            " scope TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,"
            " fields TEXT NOT NULL, generation BIGINT NOT NULL,"
            " ended DOUBLE PRECISION, PRIMARY KEY (scope, kind, name))"
        ),
        SqlStatement(
            "CREATE TABLE IF NOT EXISTS mirage_console ("
            " scope TEXT NOT NULL, name TEXT NOT NULL, seq BIGINT NOT NULL,"
            " ts DOUBLE PRECISION NOT NULL, channel TEXT NOT NULL,"
            f" data {blob} NOT NULL, PRIMARY KEY (scope, name, seq))"
        ),
    ]


def _console_names(fields: RecordFields | None) -> set[str]:
    """The consoles a job list names, its disowned jobs' included.

    Args:
        fields (RecordFields | None): the list, or None.
    """
    if fields is None:
        return set()
    listed = {job["console"] for job in fields.get("jobs", {}).values()}
    return listed | set(fields.get("disowned", {}))


def _record_of(record: Line | Process) -> tuple[str, str, RecordFields]:
    """A record's kind, its row's name and its fields.

    Args:
        record (Line | Process): the record.
    """
    if isinstance(record, Line):
        return "line", record.id.value, line_to_fields(record)
    return "process", str(record.pid), process_to_fields(record)


class SqlExecutionStore(ExecutionStore):
    """ExecutionStore in a SQL database, SQLite or Postgres, shared by
    every process on it, as rows of two tables it makes on first use:

    - ``mirage_execution``: one row per thing the plane keeps, by kind:
      a session's job list (``list``, CAS on its generation column), the
      workspace's lease (``lease``, the holder in ``fields`` and when it
      lapses in ``ended``), the highest pid (``pid``, in ``generation``),
      the processes a daemon publishes (``published``), a stop asked of
      a daemon (``stop:<daemon>``), and each line and process record
      (``line``, ``process``, with ``ended`` set once they end)
    - ``mirage_console``: each job's console, one row per chunk
      (``SqlConsoleStore``)

    Every change that two daemons may race on is one conditional
    statement, so the database settles it. Records are written in the
    background, in batches, the newest of each winning, and the ended
    ones are trimmed to the history as they are written; ``close``
    writes what is left. Rows are scoped, so many workspaces share one
    database. Mirrors TypeScript's ``SqlExecutionStore``.

    Args:
        driver (SqlDriver): the database.
        scope (str): this workspace's scope in it.
        lease_seconds (float | None): see ``ExecutionStore``.
    """

    def __init__(
        self,
        driver: SqlDriver,
        scope: str = "",
        lease_seconds: float | None = LEASE_SECONDS,
    ) -> None:
        super().__init__(lease_seconds)
        self._driver = driver
        self._scope = scope
        self._ready = False
        self._consoles: dict[str, SqlConsoleStore] = {}
        self._pending: dict[tuple[str, str], Line | Process] = {}
        self._pending_lock = threading.Lock()
        self._writing = False
        self._writer: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    async def _schema(self) -> None:
        """Make the tables once. Two processes making them at once can
        both find them missing, and Postgres refuses the second, which
        finds them made when it tries again."""
        if self._ready:
            return
        statements = _schema(self._driver.dialect)
        try:
            await run_blocking(self._driver.batch, statements)
        except Exception as exc:
            logger.debug("execution tables made elsewhere first: %s", exc)
            await run_blocking(self._driver.batch, statements)
        self._ready = True

    async def _query(
        self, key: str, params: tuple[SqlValue, ...]
    ) -> list[SqlRow]:
        await self._schema()
        return await run_blocking(
            self._driver.query, EXECUTION_SQL[key], (self._scope, *params)
        )

    async def _batch(self, statements: Sequence[SqlStatement]) -> None:
        await self._schema()
        await run_blocking(self._driver.batch, statements)

    async def _fields(self, kind: str, name: str) -> RecordFields | None:
        rows = await self._query("get", (kind, name))
        return json.loads(str(rows[0]["fields"])) if rows else None

    async def _drop(self, names: set[str]) -> None:
        """Drop consoles no job list names any more.

        Args:
            names (set[str]): the consoles.
        """
        if names:
            await self._batch(
                [
                    SqlStatement(
                        EXECUTION_SQL["drop_console"], (self._scope, name)
                    )
                    for name in sorted(names)
                ]
            )
        for name in names:
            self._consoles.pop(name, None)

    async def load(self, session_id: str) -> RecordFields | None:
        return await self._fields("list", session_id)

    async def cas_set(
        self, session_id: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        stored = await self._fields("list", session_id)
        body = json.dumps(fields)
        generation = generation_of(fields)
        if expected_generation == 0:
            landed = await self._query(
                "insert_new", (session_id, body, generation)
            )
        else:
            landed = await run_blocking(
                self._driver.query,
                EXECUTION_SQL["update_at"],
                (
                    body,
                    generation,
                    self._scope,
                    session_id,
                    expected_generation,
                ),
            )
        if not landed:
            return False
        await self._drop(_console_names(stored) - _console_names(fields))
        return True

    async def delete(self, session_id: str, expected_generation: int) -> bool:
        rows = await self._query(
            "delete_at", (session_id, expected_generation)
        )
        if rows:
            await self._drop(
                _console_names(json.loads(str(rows[0]["fields"])))
            )
            return True
        return (
            expected_generation == 0
            and await self._fields("list", session_id) is None
        )

    def console(self, name: str) -> SqlConsoleStore:
        if name not in self._consoles:
            self._consoles[name] = SqlConsoleStore(
                self._driver, self._scope, name, self._schema
            )
        return self._consoles[name]

    async def lease(
        self, daemon: str, consoles: Sequence[str] = ()
    ) -> str | None:
        now = time.time()
        expires = (
            None if self.lease_seconds is None else now + self.lease_seconds
        )
        held = json.dumps(daemon)
        if await self._query("lease", (held, expires, now)):
            return None
        return await self.holder()

    async def holder(self) -> str | None:
        rows = await self._query("get", ("lease", ""))
        if not rows:
            return None
        ended = rows[0]["ended"]
        if ended is not None and float(ended) <= time.time():
            return None
        return str(json.loads(str(rows[0]["fields"])))

    async def release(self, daemon: str) -> None:
        await self._query("release", (json.dumps(daemon),))

    async def publish(
        self,
        daemon: str,
        processes: Mapping[str, RecordFields],
        last_pid: int = 0,
    ) -> None:
        statements = [
            SqlStatement(EXECUTION_SQL["raise_pid"], (self._scope, last_pid))
        ]
        if processes:
            statements.append(
                SqlStatement(
                    EXECUTION_SQL["put"],
                    (
                        self._scope,
                        "published",
                        daemon,
                        json.dumps(dict(processes)),
                        0,
                        None,
                    ),
                )
            )
        else:
            statements += [
                SqlStatement(
                    EXECUTION_SQL["delete"], (self._scope, "published", daemon)
                ),
                SqlStatement(
                    EXECUTION_SQL["delete_kind"],
                    (self._scope, f"stop:{daemon}"),
                ),
            ]
        await self._batch(statements)

    async def processes(self) -> dict[str, dict[str, RecordFields]]:
        rows = await self._query("kind", ("published",))
        return {
            str(row["name"]): json.loads(str(row["fields"])) for row in rows
        }

    async def highest_pid(self) -> int:
        rows = await self._query("get", ("pid", ""))
        return int(rows[0]["generation"] or 0) if rows else 0

    async def request_stop(self, daemon: str, pid: int, signal: int) -> None:
        await self._batch(
            [
                SqlStatement(
                    EXECUTION_SQL["put"],
                    (
                        self._scope,
                        f"stop:{daemon}",
                        uuid.uuid4().hex,
                        json.dumps([pid, signal]),
                        time.time_ns(),
                        None,
                    ),
                )
            ]
        )

    async def take_stops(self, daemon: str) -> list[tuple[int, int]]:
        rows = await self._query("take_kind", (f"stop:{daemon}",))
        ordered = sorted(rows, key=lambda row: int(row["generation"] or 0))
        return [
            (int(pid), int(sig))
            for pid, sig in (json.loads(str(row["fields"])) for row in ordered)
        ]

    def note(self, record: Line | Process) -> None:
        kind, name, _ = _record_of(record)
        with self._pending_lock:
            self._pending[(kind, name)] = record
            if self._writing:
                return
            self._writing = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            if self._loop is None or self._loop.is_closed():
                with self._pending_lock:
                    self._writing = False
                return
            self._loop.call_soon_threadsafe(self._write_soon)
            return
        self._loop = loop
        self._write_soon()

    def _write_soon(self) -> None:
        self._writer = asyncio.ensure_future(self._write_pending())

    async def _write_pending(self) -> None:
        """Write the records noted since the last batch, until none are
        left, trimming each kind's ended ones to the history; a batch
        that fails is logged and dropped."""
        while True:
            with self._pending_lock:
                batch, self._pending = self._pending, {}
                if not batch:
                    self._writing = False
                    return
            statements: list[SqlStatement] = []
            newest: dict[str, float] = {}
            for record in batch.values():
                kind, name, fields = _record_of(record)
                statements.append(
                    SqlStatement(
                        EXECUTION_SQL["put"],
                        (
                            self._scope,
                            kind,
                            name,
                            json.dumps(fields),
                            0,
                            record.ended_at,
                        ),
                    )
                )
                if record.ended_at is not None:
                    newest[kind] = max(
                        newest.get(kind, record.ended_at), record.ended_at
                    )
            for kind, ended in newest.items():
                statements.append(
                    SqlStatement(
                        EXECUTION_SQL["prune"],
                        (
                            self._scope,
                            kind,
                            ended - HISTORY_SECONDS,
                            self._scope,
                            kind,
                            HISTORY_MAX_RECORDS,
                        ),
                    )
                )
            try:
                await self._batch(statements)
            except Exception as exc:
                logger.debug("execution records not written: %s", exc)

    async def _flush(self) -> None:
        """Wait for the records noted so far to be written."""
        writer = self._writer
        if writer is not None and not writer.done():
            await writer
        with self._pending_lock:
            if self._writing or not self._pending:
                return
            self._writing = True
        await self._write_pending()

    def _noted(self, kind: str) -> list[Line | Process]:
        """The records noted but not written yet, of one kind.

        Args:
            kind (str): ``line`` or ``process``.
        """
        with self._pending_lock:
            return [
                record
                for (noted, _), record in self._pending.items()
                if noted == kind
            ]

    async def get_line(self, line_id: LineId) -> Line | None:
        with self._pending_lock:
            noted = self._pending.get(("line", line_id.value))
        if isinstance(noted, Line):
            return noted
        fields = await self._fields("line", line_id.value)
        return line_from_fields(fields) if fields is not None else None

    async def get_process(self, process_id: ProcessId) -> Process | None:
        name = str(process_id.pid)
        with self._pending_lock:
            noted = self._pending.get(("process", name))
        if isinstance(noted, Process):
            return noted
        fields = await self._fields("process", name)
        return process_from_fields(fields) if fields is not None else None

    async def find_lines(self, session_id: str | None = None) -> list[Line]:
        rows = await self._query("kind", ("line",))
        found = {
            line.id: line
            for line in (
                line_from_fields(json.loads(str(row["fields"])))
                for row in rows
            )
        }
        for noted in self._noted("line"):
            if isinstance(noted, Line):
                found[noted.id] = noted
        return sorted(
            (
                line
                for line in found.values()
                if session_id is None or line.session_id == session_id
            ),
            key=lambda line: line.started_at,
        )

    async def find_processes(
        self, session_id: str | None = None
    ) -> list[Process]:
        rows = await self._query("kind", ("process",))
        found = {
            record.pid: record
            for record in (
                process_from_fields(json.loads(str(row["fields"])))
                for row in rows
            )
        }
        for noted in self._noted("process"):
            if isinstance(noted, Process):
                found[noted.pid] = noted
        return sorted(
            (
                record
                for record in found.values()
                if session_id is None or record.session_id == session_id
            ),
            key=lambda record: record.pid,
        )

    async def clear(self) -> None:
        await self._flush()
        await self._batch(
            [
                SqlStatement(EXECUTION_SQL["clear"], (self._scope,)),
                SqlStatement(EXECUTION_SQL["clear_consoles"], (self._scope,)),
            ]
        )
        self._consoles.clear()

    async def close(self) -> None:
        await self._flush()
        for console in self._consoles.values():
            await console.close()
