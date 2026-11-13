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

import hashlib
import json
import logging
import os
from collections.abc import Callable
from dataclasses import replace
from typing import Any
from urllib.parse import quote

from opentelemetry import context as context_api
from opentelemetry import trace

from mirage.execution.constants import HISTORY_MAX_RECORDS
from mirage.execution.job.types import Job
from mirage.execution.process.types import Process, ProcessState
from mirage.execution.types import MachineName
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.types import IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.observe.constants import (
    NAME_LIMIT,
    TRACE_CONTENT_ENV,
    TRACE_CONTENT_MAX_BYTES,
    TRACE_CONTENT_MAX_BYTES_ENV,
    TRACER_NAME,
)
from mirage.observe.log_entry import (
    EVENT_CLEAR,
    EVENT_COMMAND,
    EVENT_DELETE,
    EVENT_RESULT,
    EVENT_VFS,
    STDOUT_TRUNCATE,
    LogEntry,
)
from mirage.observe.record import OpRecord
from mirage.observe.store import ObserverStore, RAMObserverStore
from mirage.utils.clock import Clock, SystemClock
from mirage.utils.dates import utc_date_folder

logger = logging.getLogger(__name__)

_KNOWN_EVENTS = (
    EVENT_COMMAND,
    EVENT_CLEAR,
    EVENT_DELETE,
    EVENT_RESULT,
    EVENT_VFS,
)

_NS_PER_MS = 1_000_000


def _env_var(name: str) -> str:
    return os.environ.get(name, "").strip()


def _trace_content() -> bool:
    """Whether spans carry content: on unless ``TRACE_CONTENT_ENV``
    turns it off."""
    return _env_var(TRACE_CONTENT_ENV).lower() not in ("false", "0")


def _positive_env(name: str, default: int) -> int:
    value = _env_var(name)
    limit = int(value) if value.isdigit() else 0
    return limit if limit > 0 else default


def _trace_content_max_bytes() -> int:
    return _positive_env(TRACE_CONTENT_MAX_BYTES_ENV, TRACE_CONTENT_MAX_BYTES)


def kept_output_bytes() -> int:
    """The bytes of each stream a line's terminal keeps for its record
    while a reader takes the line: ``CHUNK_SIZE``, or the span's cap
    when content is traced and the cap is larger. Mirrors TypeScript's
    ``keptOutputBytes``."""
    if not _trace_content():
        return CHUNK_SIZE
    return max(CHUNK_SIZE, _trace_content_max_bytes())


def _traced_output(raw: bytes, limit: int) -> str:
    """The start of ``raw`` as text of at most ``limit`` bytes in UTF-8.
    A byte that isn't UTF-8 reads as U+FFFD, three bytes, so the text is
    cut again after decoding, before the character that would cross
    ``limit``. Mirrors TypeScript's ``tracedOutput``.

    Args:
        raw (bytes): a stream as the line wrote it.
        limit (int): the most bytes the text may take.
    """
    text = raw[:limit].decode(errors="replace")
    encoded = text.encode()
    if len(encoded) <= limit:
        return text
    # The text is UTF-8, so only the character ``limit`` cuts through is
    # left incomplete, and it is dropped.
    return encoded[:limit].decode(errors="ignore")


def _session_file(session: str) -> str:
    """The name a session's log goes under in each day: its id
    percent-quoted, so no id spans folders or ends like another's. One
    that quotes past ``NAME_LIMIT`` keeps its start and ends in a hash
    of the whole id, a character longer than the limit, so the name fits
    a filesystem and meets no shorter one.

    Args:
        session (str): the session id.
    """
    quoted = quote(session, safe="")
    if len(quoted) > NAME_LIMIT:
        digest = hashlib.sha256(session.encode()).hexdigest()
        quoted = f"{quoted[: NAME_LIMIT - len(digest)]}~{digest}"
    return f"{quoted}.jsonl"


def _tracer() -> trace.Tracer:
    """The tracer a finished line goes to: a no-op until the process
    sets up an OpenTelemetry SDK, whose exporter picks the backend."""
    return trace.get_tracer(TRACER_NAME)


def _start_line(
    workspace_id: str | None,
    machine: str | None,
    line: str,
    session: str,
    command: str,
    cwd: str | None,
    start: int,
) -> trace.Span:
    """Open a typed line's ``command`` span as it starts, naming the
    line, its session, its workspace, the host running Mirage and the
    cwd it starts in; the spans of its jobs and processes go under it.

    Args:
        workspace_id (str | None): the workspace the line runs in.
        machine (str | None): the host running Mirage, ``host.name``.
        line (str): the line's id.
        session (str): the session it runs in.
        command (str): the typed line.
        cwd (str | None): the session cwd it starts in.
        start (int): its start, epoch milliseconds.
    """
    attributes: dict[str, str | int] = {
        "mirage.line.id": line,
        "mirage.session.id": session,
        "mirage.command": command,
        "mirage.timestamp": start,
    }
    if workspace_id is not None:
        attributes["mirage.workspace.id"] = workspace_id
    if machine is not None:
        attributes["host.name"] = machine
    if cwd is not None:
        attributes["mirage.cwd"] = cwd
    return _tracer().start_span(
        "command", start_time=start * _NS_PER_MS, attributes=attributes
    )


def _end_line(
    line: trace.Span,
    span: tuple[int, int],
    exit_code: int,
    output: tuple[bytes, bytes],
) -> None:
    """Close a typed line's ``command`` span: how it ended and the start
    of its stdout and stderr. It also carries its length in
    milliseconds, as the history's entries have it, for a tracer that
    can't be given a span's times. ``TRACE_CONTENT_ENV`` leaves out the
    output. The calls the line made to mounts are its commands' own
    work, so they stay in the history and send no spans.

    Args:
        line (trace.Span): the line's span.
        span (tuple[int, int]): its start and end, epoch milliseconds.
        exit_code (int): how it ended.
        output (tuple[bytes, bytes]): its stdout and stderr as it wrote
            them.
    """
    line.set_attribute("mirage.exit_code", exit_code)
    line.set_attribute("mirage.duration_ms", span[1] - span[0])
    if _trace_content():
        limit = _trace_content_max_bytes()
        line.set_attribute("mirage.stdout", _traced_output(output[0], limit))
        line.set_attribute("mirage.stderr", _traced_output(output[1], limit))
    line.end(end_time=span[1] * _NS_PER_MS)


def _parse_files(files: dict[str, bytes]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for key in sorted(files.keys()):
        if not key.endswith(".jsonl"):
            continue
        for line in files[key].decode(errors="replace").split("\n"):
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError as e:
                # A crash mid-append tears a line and the entry appended onto it.
                logger.debug(
                    "skipping unparseable history line in %s: %s", key, e
                )
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

    Each typed line also goes to OpenTelemetry as a span, and so does
    each job and process once it ends: a process under the one that
    started it, a job's process under its job, and the line's own under
    the line's span while the newest ``HISTORY_MAX_RECORDS`` lines' spans
    are known. A process links to each it reads from, ``mirage.input``
    naming where: its ``stdin``, a ``/dev/fd`` path or its ``argv``.
    Nothing leaves the process until an SDK is set up. Tracing stops at
    the workspace's own machine and runtimes: a program a runtime runs
    elsewhere starts no trace of its own there.

    Args:
        store (ObserverStore | None): Storage backend for log files;
            defaults to an in-memory RAMObserverStore.
        clock (Clock | None): the workspace clock; None is the system
            clock.
        workspace_id (str | None): the workspace, named on its spans.
        machine (str | None): the host running Mirage, ``host.name`` on
            its command, job and process spans.
        processes (Callable[[], list[Process]] | None): the process
            records the workspace keeps, which a span goes under.
        instance (Callable[[MachineName], str] | None): what each
            machine's provider calls it, ``mirage.machine.id`` for a
            record that does not say.
    """

    def __init__(
        self,
        store: ObserverStore | None = None,
        clock: Clock | None = None,
        workspace_id: str | None = None,
        machine: str | None = None,
        processes: Callable[[], list[Process]] | None = None,
        instance: Callable[[MachineName], str] | None = None,
    ) -> None:
        self._store = store if store is not None else RAMObserverStore()
        self._clock: Clock = clock if clock is not None else SystemClock()
        self._workspace_id = workspace_id
        self._machine = machine
        self._processes = processes
        self._instance = instance
        self._newest: dict[str, int | None] = {}
        # Each open line's start (epoch ms, then monotonic) and span.
        self._started: dict[str, tuple[int, float, trace.Span]] = {}
        # The span of each recent line, which its jobs and processes go
        # under, oldest first.
        self._line_spans: dict[str, trace.SpanContext] = {}
        # The span of each job and process open now, by kind, line and
        # pid, and of the newest ended ones, which one started under them
        # still goes under, oldest first.
        self._open: dict[tuple[str, str | None, int], trace.Span] = {}
        self._closed: dict[tuple[str, str | None, int], trace.SpanContext] = {}
        # The pid each of those processes shows, by the same key: its
        # program's on its machine, else Mirage's own.
        self._shown: dict[tuple[str, str | None, int], int] = {}

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
            files = await self._store.read_matching(
                f"/{_session_file(session)}"
            )
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
        await self._store.append(
            f"/{day}/{_session_file(entry.session)}", line
        )

    async def log_op(
        self,
        rec: OpRecord,
        session: str,
        cwd: str | None = None,
        parent: str | None = None,
    ) -> None:
        """Persist an OpRecord as a JSONL line.

        Args:
            rec (OpRecord): The operation record.
            session (str): Session ID.
            cwd (str | None): Session cwd at log time.
            parent (str | None): The line that made the call.
        """
        await self._log(LogEntry.from_op_record(rec, session, cwd, parent))

    async def log_command(
        self,
        command: str,
        session: str,
        cwd: str | None = None,
        line: str | None = None,
    ) -> None:
        """Record a typed line as it starts, under its id, which its vfs
        calls and its result name as their parent.

        Args:
            command (str): The typed line, verbatim and unexpanded.
            session (str): Session the line runs in.
            cwd (str | None): Session cwd at its start.
            line (str | None): The line's id.
        """
        entry = LogEntry(
            type=EVENT_COMMAND,
            session=session,
            timestamp=self._now_ms(),
            cwd=cwd,
            id=line,
            command=command,
        )
        began = self._clock.monotonic()
        await self._log(entry)
        if line is not None:
            span = _start_line(
                self._workspace_id,
                self._machine,
                line,
                session,
                command,
                cwd,
                entry.timestamp,
            )
            self._started[line] = (entry.timestamp, began, span)
            self._line_spans[line] = span.get_span_context()
            while len(self._line_spans) > HISTORY_MAX_RECORDS:
                del self._line_spans[next(iter(self._line_spans))]

    async def log_result(
        self,
        io: IOResult,
        op_records: list[OpRecord],
        session: str,
        cwd: str | None = None,
        line: str | None = None,
    ) -> None:
        """Record how a typed line ended: its vfs calls, then its result,
        each naming the line as its parent. A line ends once: a second
        call for a line already ended records nothing.

        Args:
            io (IOResult): Final result of the line.
            op_records (list[OpRecord]): Calls collected while it ran.
            session (str): Session the line ran in.
            cwd (str | None): Session cwd at completion.
            line (str | None): The line's id.
        """
        # TODO: batch the vfs lines and the result line into a single
        # store.append so one typed line costs one roundtrip and lands
        # atomically in the store. A store whose append never suspends
        # still lets the loop run between a long line's records.
        started = self._started.pop(line, None) if line is not None else None
        if line is not None and started is None:
            return
        budget = YieldBudget()
        for rec in op_records:
            await budget.run()
            await self.log_op(rec, session, cwd, line)
        stdout = await io.materialize_stdout()
        stderr = await io.materialize_stderr()
        out = stdout.decode(errors="replace")[:STDOUT_TRUNCATE]
        err = stderr.decode(errors="replace")[:STDOUT_TRUNCATE]
        now = self._now_ms()
        took = (
            None
            if started is None
            else round((self._clock.monotonic() - started[1]) * 1000)
        )
        if started is not None and took is not None:
            _end_line(
                started[2],
                (started[0], started[0] + took),
                io.exit_code,
                (stdout, stderr),
            )
        await self._log(
            LogEntry(
                type=EVENT_RESULT,
                session=session,
                timestamp=now,
                cwd=cwd,
                parent=line,
                exit_code=io.exit_code,
                stdout=out,
                stderr=err,
                duration_ms=took,
            )
        )

    def trace_process(self, record: Process) -> None:
        """Send an ended process to OpenTelemetry as a ``process`` span:
        what it ran, where and as whom, how it ended, and a link to each
        process it read from, whose span is known by then.

        Args:
            record (Process): the process's record.
        """
        line = record.line.value if record.line is not None else None
        if not self._traced(line):
            return
        span = self._process_span(record)
        if record.exit is not None:
            span.set_attribute("process.exit.code", record.exit)
        if record.signal is not None:
            span.set_attribute("mirage.signal", record.signal)
        if record.error is not None:
            span.set_attribute("mirage.error", record.error)
        inputs = [] if record.stdin is None else [("stdin", record.stdin)]
        inputs += [(f"/dev/fd/{fd}", pid) for fd, pid in record.fd.items()]
        inputs += [("argv", pid) for pid in record.argv]
        for value, pid in inputs:
            known = self._known(record, pid)
            if known is not None:
                span.add_link(known, {"mirage.input": value})
        span.set_attributes(
            {
                "process.pid": record.shown_pid,
                **self._machine_attributes(
                    record.machine, record.machine_instance
                ),
            }
        )
        self._shown[("process", line, record.pid)] = record.shown_pid
        self._end(("process", line, record.pid), record.ended_at)

    def trace_job(self, record: Job, process: Process | None) -> None:
        """Send a job to OpenTelemetry as a ``job`` span, opened as it
        starts, so its process goes under it, and closed as it ends: what
        it ran, where and as whom, and how it ended.

        Args:
            record (Job): the job's record.
            process (Process | None): its process's record, which names
                where its program runs once it does.
        """
        line = record.line.value if record.line is not None else None
        if not self._traced(line):
            return
        span = self._job_span(record, process)
        if record.ended_at is None:
            return
        if process is not None:
            span.set_attributes(
                {
                    "process.pid": process.shown_pid,
                    **self._machine_attributes(
                        process.machine, process.machine_instance
                    ),
                }
            )
        if record.exit is not None:
            span.set_attribute("mirage.exit_code", record.exit)
        if record.signal is not None:
            span.set_attribute("mirage.signal", record.signal)
        self._end(("job", line, record.pid or 0), record.ended_at)

    def _traced(self, line: str | None) -> bool:
        """Whether anyone traces the line: not when its span is one
        nobody records, so an untraced workspace reads no records.

        Args:
            line (str | None): the line's id.
        """
        known = self._line_spans.get(line) if line is not None else None
        return known is None or known.is_valid

    def _machine_attributes(
        self, machine: MachineName, instance: str | None = None
    ) -> dict[str, str | int]:
        """The attributes naming where a span's work ran: the machine's
        provider, its name and what its provider calls it.

        Args:
            machine (MachineName): the machine.
            instance (str | None): what its provider called it when the
                work started, when the record kept it.
        """
        if instance is None:
            instance = (
                machine.name
                if self._instance is None
                else self._instance(machine)
            )
        return {
            "mirage.machine.type": machine.provider,
            "mirage.machine.name": machine.name,
            "mirage.machine.id": instance,
        }

    def _context(
        self, key: tuple[str, str | None, int]
    ) -> context_api.Context | None:
        """The context a span goes under to be under ``key``'s span,
        None while there is none.

        Args:
            key (tuple[str, str | None, int]): the span's kind, line and
                pid.
        """
        span = self._open.get(key)
        if span is not None:
            return trace.set_span_in_context(span)
        known = self._closed.get(key)
        if known is not None:
            return trace.set_span_in_context(trace.NonRecordingSpan(known))
        return None

    def _under(self, record: Process) -> context_api.Context | None:
        """The context ``record``'s span goes under: its parent's span,
        opened now when its parent still runs, else its line's.

        Args:
            record (Process): the process.
        """
        line = record.line.value if record.line is not None else None
        if record.parent is not None:
            found = self._context(("process", line, record.parent))
            if found is not None:
                return found
            parent = next(
                (
                    p
                    for p in (self._processes() if self._processes else [])
                    if p.pid == record.parent
                    and p.line == record.line
                    and p.state != ProcessState.EXITED
                ),
                None,
            )
            if parent is not None:
                return trace.set_span_in_context(self._process_span(parent))
        known = self._line_spans.get(line) if line is not None else None
        if known is None:
            return None
        return trace.set_span_in_context(trace.NonRecordingSpan(known))

    def _process_span(self, record: Process) -> trace.Span:
        """``record``'s span, opened the first time it is needed (as it
        ends, or as the first process under it does) from its own start:
        under its job's span when it is a job's process, else under its
        parent's or its line's.

        Args:
            record (Process): the process.
        """
        line = record.line.value if record.line is not None else None
        span = self._open.get(("process", line, record.pid))
        if span is not None:
            return span
        under = self._context(("job", line, record.pid))
        if under is None:
            under = self._under(record)
        self._shown[("process", line, record.pid)] = record.shown_pid
        attributes: dict[str, str | int] = {
            "process.pid": record.shown_pid,
            "mirage.process.pid": record.pid,
            "process.command_line": record.command,
            "process.group_leader.pid": self._shown.get(
                ("process", line, record.group), record.group
            ),
            **self._machine_attributes(
                record.machine, record.machine_instance
            ),
            "mirage.workspace.id": record.id.workspace_id,
            "mirage.session.id": record.session_id,
            "mirage.cwd": record.cwd.virtual,
        }
        if record.parent is not None:
            attributes["process.parent_pid"] = self._shown.get(
                ("process", line, record.parent), record.parent
            )
        if record.runtime is not None:
            attributes["mirage.runtime"] = record.runtime
        return self._start(
            ("process", line, record.pid), attributes, under, record.started_at
        )

    def _known(self, record: Process, pid: int) -> trace.SpanContext | None:
        """The span of the process ``pid`` of ``record``'s line, opened now
        when it still runs, None when it is not known.

        Args:
            record (Process): a process of the line.
            pid (int): the other process.
        """
        line = record.line.value if record.line is not None else None
        span = self._open.get(("process", line, pid))
        if span is not None:
            return span.get_span_context()
        known = self._closed.get(("process", line, pid))
        if known is not None:
            return known
        other = next(
            (
                p
                for p in (self._processes() if self._processes else [])
                if p.pid == pid and p.line == record.line
            ),
            None,
        )
        if other is None:
            return None
        return self._process_span(other).get_span_context()

    def _job_span(self, record: Job, process: Process | None) -> trace.Span:
        """``record``'s span, opened the first time it is needed from its
        own start, under the span its process would go under.

        Args:
            record (Job): the job.
            process (Process | None): its process.
        """
        line = record.line.value if record.line is not None else None
        key = ("job", line, record.pid or 0)
        span = self._open.get(key)
        if span is not None:
            return span
        under = None
        if process is not None:
            under = self._under(process)
        elif line is not None and line in self._line_spans:
            under = trace.set_span_in_context(
                trace.NonRecordingSpan(self._line_spans[line])
            )
        attributes: dict[str, str | int] = {
            "mirage.job.id": record.id.console,
            "mirage.job.number": record.number,
            "mirage.command": record.command,
            "mirage.workspace.id": record.id.workspace_id,
            "mirage.session.id": record.session_id,
            "mirage.cwd": record.cwd,
        }
        if process is not None:
            attributes.update(
                self._machine_attributes(
                    process.machine, process.machine_instance
                )
            )
        if record.pid is not None:
            attributes["process.pid"] = (
                record.pid if process is None else process.shown_pid
            )
            attributes["mirage.process.pid"] = record.pid
        return self._start(key, attributes, under, record.started_at)

    def _start(
        self,
        key: tuple[str, str | None, int],
        attributes: dict[str, str | int],
        under: context_api.Context | None,
        started_at: float,
    ) -> trace.Span:
        """Open the span of a job or process from its start, naming the
        host and its line, and keep it open under ``key``.

        Args:
            key (tuple[str, str | None, int]): its kind, line and pid.
            attributes (dict[str, str | int]): what it carries.
            under (context_api.Context | None): the context it goes
                under; None starts a trace of its own.
            started_at (float): when it started, epoch seconds.
        """
        if self._machine is not None:
            attributes["host.name"] = self._machine
        if key[1] is not None:
            attributes["mirage.line.id"] = key[1]
        span = _tracer().start_span(
            key[0],
            context=under,
            start_time=int(started_at * 1_000_000_000),
            attributes=attributes,
        )
        self._open[key] = span
        return span

    def _end(
        self, key: tuple[str, str | None, int], ended_at: float | None
    ) -> None:
        """Close the open span ``key`` names as of ``ended_at``, keeping
        its context for what started under it and ends later.

        Args:
            key (tuple[str, str | None, int]): its kind, line and pid.
            ended_at (float | None): when it ended, epoch seconds; None
                ends it now.
        """
        span = self._open.pop(key)
        span.end(
            end_time=None
            if ended_at is None
            else int(ended_at * 1_000_000_000)
        )
        self._closed.pop(key, None)
        self._closed[key] = span.get_span_context()
        while len(self._closed) > HISTORY_MAX_RECORDS:
            gone = next(iter(self._closed))
            del self._closed[gone]
            self._shown.pop(gone, None)

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

    async def log_delete(
        self, session: str, listing: list[dict[str, Any]], index: int
    ) -> None:
        """Append a delete event for one listing entry (history -d).

        The event names the entry by its timestamp and text and by how
        many entries alike in both follow it, counted from the newest end,
        so a store that drops its oldest lines never turns it on another
        entry.

        Args:
            session (str): Session ID whose entry is deleted.
            listing (list[dict[str, Any]]): the session's listing.
            index (int): the deleted entry's place in it.
        """
        entry = listing[index]
        named = (entry.get("timestamp"), entry.get("command"))
        await self._log(
            LogEntry(
                type=EVENT_DELETE,
                session=session,
                timestamp=self._now_ms(),
                command=entry.get("command", ""),
                target=entry.get("timestamp", 0),
                after=sum(
                    (e.get("timestamp"), e.get("command")) == named
                    for e in listing[index + 1 :]
                ),
            )
        )

    async def events(self, session: str | None = None) -> list[dict[str, Any]]:
        """All recorded events, in timestamp order: every session's, or
        only ``session``'s, read from its own log alone.

        Timestamps are UTC epoch milliseconds. The sort is stable over
        the per-file line order, so events that share a millisecond
        (one line's ops plus its command entry) keep the order they
        were appended in; append order within a session file is the
        contract.

        Args:
            session (str | None): only this session's events.

        Returns:
            list[dict]: Parsed LogEntry dicts.
        """
        files = (
            await self._store.read_all()
            if session is None
            else await self._store.read_matching(f"/{_session_file(session)}")
        )
        out = _parse_files(files)
        out.sort(key=lambda e: e.get("timestamp", 0))
        return out

    async def command_events(self) -> list[dict[str, Any]]:
        """The command events of every session's ended lines, in the
        order they ended: a line enters its history once its result is
        in, and an entry added without running (``history -s``) at once,
        so the listing only ever grows at its end.

        Returns:
            list[dict]: Events with type == EVENT_COMMAND.
        """
        ended: list[dict[str, Any]] = []
        running: dict[str, dict[str, Any]] = {}
        for e in await self.events():
            kind = e.get("type")
            if kind == EVENT_COMMAND and e.get("id") is None:
                ended.append(e)
            elif kind == EVENT_COMMAND:
                running[e["id"]] = e
            elif kind == EVENT_RESULT and e.get("parent") in running:
                ended.append(running.pop(e["parent"]))
        return ended

    async def session_command_events(
        self, session: str
    ) -> list[dict[str, Any]]:
        """One session's visible history listing, append order.

        Projects the session's events: a line joins the listing when its
        result is in (an entry added without running, ``history -s``,
        at once), a clear tombstone empties it, and a delete event drops
        the entry it names (history -d renumbers subsequent entries,
        GNU behavior).

        Args:
            session (str): Session ID to project.

        Returns:
            list[dict]: Events with type == EVENT_COMMAND.
        """
        files = await self._store.read_matching(f"/{_session_file(session)}")
        visible: list[dict[str, Any]] = []
        running: dict[str, dict[str, Any]] = {}
        for e in _parse_files(files):
            kind = e.get("type")
            if kind == EVENT_COMMAND and e.get("id") is None:
                visible.append(e)
            elif kind == EVENT_COMMAND:
                running[e["id"]] = e
            elif kind == EVENT_RESULT and e.get("parent") in running:
                visible.append(running.pop(e["parent"]))
            elif kind == EVENT_CLEAR:
                visible = []
            elif kind == EVENT_DELETE:
                named = (e.get("target"), e.get("command"))
                skip = e.get("after") or 0
                for idx in range(len(visible) - 1, -1, -1):
                    entry = visible[idx]
                    if (entry.get("timestamp"), entry.get("command")) != named:
                        continue
                    if skip == 0:
                        del visible[idx]
                        break
                    skip -= 1
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
        newest = _newest_stamp(
            [e for e in events if e.get("type") in _KNOWN_EVENTS]
        )
        written = (
            self._now_ms() if newest is None else max(self._now_ms(), newest)
        )
        day = utc_date_folder(written / 1000)
        by_session: dict[str, list[str]] = {}
        for e in events:
            if e.get("type") not in _KNOWN_EVENTS:
                continue
            session = e.get("session", "default")
            by_session.setdefault(session, []).append(
                json.dumps(e, separators=(",", ":"))
            )
        self._newest = {session: written for session in by_session}
        for session, lines in by_session.items():
            await self._store.write(
                f"/{day}/{_session_file(session)}",
                ("\n".join(lines) + "\n").encode(),
            )
