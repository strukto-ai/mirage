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

from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from dataclasses import replace

from mirage.context.session_context import (
    CallerToken,
    bind_caller,
    current_caller,
    current_execution_id,
    reset_caller,
)
from mirage.observe.record import (
    STAMP_FINGERPRINT_OPS,
    LostPaths,
    OpRecord,
    Recorder,
    RecordIndex,
)
from mirage.types import PathSpec
from mirage.utils.clock import Clock, SystemClock

SYSTEM_CLOCK = SystemClock()


def line_version(
    index: RecordIndex, lost: LostPaths | None, key: str
) -> tuple[bool, str | None]:
    """The version the running line itself names for ``key``.

    A lost path names the version its write lost on; otherwise the newest
    version record does, a stamp its token and a retraction none.

    Args:
        index (RecordIndex): the line's records, indexed.
        lost (LostPaths | None): the line's lost paths.
        key (str): the virtual path.

    Returns:
        tuple[bool, str | None]: whether the line knows ``key`` at all,
        and the version it names.
    """
    if lost is not None and lost.holds(key):
        return True, lost.version(key)
    rec = index.newest_version(key)
    if rec is None:
        return False, None
    if rec.op in STAMP_FINGERPRINT_OPS:
        return True, rec.fingerprint or None
    return True, None


def fresh_recorder(
    ledger: list[OpRecord] | None = None, clock: Clock | None = None
) -> Recorder:
    """An empty recorder, for a line or a call outside one.

    Args:
        ledger (list[OpRecord] | None): the workspace ledger a line hands
            its records to, None for a file call's own.
        clock (Clock | None): the workspace clock its ops are timed and
            stamped on; None is the system clock.
    """
    sink: list[OpRecord] = []
    return Recorder(
        sink=sink,
        lost=LostPaths(sink),
        index=RecordIndex(sink),
        ledger=ledger,
        clock=clock if clock is not None else SYSTEM_CLOCK,
    )


def _set_recorder(rec: Recorder | None) -> CallerToken:
    return bind_caller(replace(current_caller(), recorder=rec))


class RecordingScope:
    """Op-collection scope for one typed line.

    Opening puts a fresh Recorder on the contextvar; ``close()``
    restores whatever was active before (token-based, so scopes nest
    correctly and errors can't leave a dangling recorder). An inactive
    scope is inert: the executor's internal evaluations ($(), source,
    eval, xargs, ...) construct one so their ops flow into the
    enclosing typed line's scope instead of opening their own.

    Args:
        active (bool): False joins the enclosing scope instead of
            opening a new one.
        ledger (list[OpRecord] | None): the workspace ledger the line
            hands its records to, which a file call of that workspace
            made on the line joins.
        clock (Clock | None): the workspace clock the line's ops are
            timed and stamped on; None is the system clock.
    """

    def __init__(
        self,
        active: bool = True,
        ledger: list[OpRecord] | None = None,
        clock: Clock | None = None,
    ) -> None:
        self.records: list[OpRecord] = []
        self._token = None
        if active:
            rec = fresh_recorder(ledger, clock)
            self.records = rec.sink
            self._token = _set_recorder(rec)

    def close(self) -> None:
        """Restore the previous recorder. Idempotent."""
        if self._token is not None:
            reset_caller(self._token)
            self._token = None


def active_records() -> list[OpRecord] | None:
    """The enclosing typed line's records, or None outside one.

    A nested evaluation ($(), eval, source, xargs) opens an inert scope
    that collects nothing of its own, and its IOResult does not always
    reach the enclosing line (TypeScript returns only its streams). It
    applies against the part of these it added, so its own write records
    decide what the nested apply keeps.

    Returns:
        list[OpRecord] | None: the active recorder's sink, or None.
    """
    rec = current_caller().recorder
    return rec.sink if rec is not None else None


def _set_command_sink(
    sink: tuple[list[OpRecord] | None, list[OpRecord]] | None,
) -> CallerToken:
    return bind_caller(replace(current_caller(), command_sink=sink))


@contextmanager
def command_records(own: bool = False) -> Iterator[list[OpRecord]]:
    """Collect the records the running command itself emits.

    Yields a fresh list that :func:`record` and :func:`record_stream`
    append to, beside the line's sink, while the block runs. A nested
    block opens its own list, and a concurrent task keeps the list its
    context was copied with, so a pipeline stage never sees a sibling
    stage's records. Nothing is collected outside a recording scope.
    Each record also reaches the list of the nearest block opened with
    ``own``, which gathers everything the calls under it record.

    Args:
        own (bool): open a command's list: the dispatcher calls under
            it add to it too, and it takes nothing for the block around
            it, so a command reading another's output is not charged
            with that command's reads.

    Yields:
        list[OpRecord]: the command's own records, shared with the
        line's sink.
    """
    mine: list[OpRecord] = []
    held = current_caller().command_sink
    command = mine if own else held[0] if held is not None else None
    token = _set_command_sink((command, mine))
    try:
        yield mine
    finally:
        reset_caller(token)


def active_lost() -> LostPaths | None:
    """The running line's lost paths, None outside a recorded line."""
    rec = current_caller().recorder
    return rec.lost if rec is not None else None


def mark_lost(path: PathSpec, version: str | None = None) -> None:
    """Mark ``path`` lost on the running line, if one is recording.

    Args:
        path (PathSpec): the path whose conditional write lost.
        version (str | None): the version it lost on, if any.
    """
    lost = active_lost()
    if lost is not None:
        lost.mark(path.virtual, version)


def lost_count() -> int:
    """The running line's marks so far, for a later :func:`lift_lost`."""
    lost = active_lost()
    return lost.count if lost is not None else 0


def lift_lost(path: PathSpec, upto: int, subtree: bool = False) -> None:
    """Lift the running line's marks a removal or move of ``path`` ended.

    Args:
        path (PathSpec): the path removed or moved.
        upto (int): :func:`lost_count` when the removal or move began.
        subtree (bool): the paths below it went too.
    """
    lost = active_lost()
    if lost is not None:
        lost.lift(path.virtual, upto, subtree)


def active_recorder() -> Recorder | None:
    """Return the active Recorder for the current async context, if any."""
    return current_caller().recorder


def reset_active_recorder(token: CallerToken) -> None:
    """Restore the previous recorder after a :func:`push_mount_context`.

    Args:
        token (CallerToken): The token returned by ``push_mount_context``.
    """
    reset_caller(token)


def push_mount_context(mount_id: str | None) -> CallerToken:
    """Bind the mount instance that owns records in this async frame.

    Task-isolated: replaces the Recorder for the current task via
    ``_recorder.set`` (the new Recorder shares the same sink list, so
    records still aggregate together). Binds the unrecorded state again
    when no recorder is active. Returns the token for
    :func:`reset_active_recorder`.

    Args:
        mount_id (str | None): instance identity, absent outside a mount.
    """
    rec = current_caller().recorder
    return _set_recorder(
        None
        if rec is None
        else Recorder(
            sink=rec.sink,
            mount_id=mount_id,
            lost=rec.lost,
            index=rec.index,
            clock=rec.clock,
        )
    )


async def with_mount_context(
    it: AsyncIterator[bytes], mount_id: str | None = None
) -> AsyncIterator[bytes]:
    """Wrap an async iterator so the recorder's mount_id is ``mount_id``
    during each ``__anext__`` of the underlying stream.

    Lets dispatchers preserve VFS backends as
    ``async def with yield`` while still stamping the serving mount's
    identity on records emitted lazily during stream consumption. A
    None ``mount_id`` inherits the consuming frame's.

    Args:
        it (AsyncIterator[bytes]): The stream to wrap.
        mount_id (str | None): Captured mount identity for lazy reads.
    """
    aiter = it.__aiter__()
    try:
        while True:
            previous = current_caller().recorder
            token = push_mount_context(
                mount_id
                if mount_id is not None
                else previous.mount_id
                if previous
                else None
            )
            try:
                chunk = await aiter.__anext__()
            except StopAsyncIteration:
                return
            finally:
                reset_active_recorder(token)
            yield chunk
    finally:
        close = getattr(aiter, "aclose", None)
        if close is not None:
            await close()


class OpTimer:
    """A running stopwatch for one op, owned by the record path.

    Opened where the backend work begins and read once when the op
    finishes, so an op module hands this around instead of reading a
    clock of its own. The wall-clock stamp the record carries is taken
    at finish time, not here, on the same clock.

    Args:
        clock (Clock): the clock the op is timed and stamped on.
    """

    __slots__ = ("_start_ms", "clock")

    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self._start_ms = int(clock.monotonic() * 1000)

    @property
    def elapsed_ms(self) -> int:
        """Milliseconds elapsed since the timer was opened."""
        return int(self.clock.monotonic() * 1000) - self._start_ms


def start_op() -> OpTimer:
    """Open the record path's stopwatch for one op.

    The timer runs on the clock of the line recording the op, so an op
    of a workspace on a manual clock takes the time that clock says.
    Outside a recording nothing keeps the record, and the system clock
    times it.

    Returns:
        OpTimer: a running timer, to hand to :func:`record` or
        :func:`finish_record` when the op completes.
    """
    rec = current_caller().recorder
    return OpTimer(rec.clock if rec is not None else SYSTEM_CLOCK)


def finish_record(
    op: str,
    path: str,
    source: str,
    nbytes: int,
    timer: OpTimer,
    fingerprint: str | None = None,
    revision: str | None = None,
) -> OpRecord:
    """Close ``timer`` and build the finished record.

    The one place an op's duration and wall-clock stamp are read, both
    on the timer's clock.

    Args:
        op (str): Operation name ("read", "write").
        path (str): The full virtual path, stored as given.
        source (str): VFS name ("s3", "ram", "disk").
        nbytes (int): Bytes transferred.
        timer (OpTimer): the timer opened when the op started.
        fingerprint (str | None): Content-derived identifier returned by
            the backend (ETag, md5). Used for drift detection at replay.
        revision (str | None): Stable revision handle returned by the
            backend (S3 ``VersionId``, Drive ``revisionId``, Git SHA).
    """
    elapsed = timer.elapsed_ms
    recorder = current_caller().recorder
    return OpRecord(
        op=op,
        path=path,
        source=source,
        bytes=nbytes,
        timestamp=int(timer.clock.now() * 1000),
        duration_ms=elapsed,
        fingerprint=fingerprint,
        revision=revision,
        mount_id=recorder.mount_id if recorder is not None else None,
        execution_id=current_execution_id(),
    )


def _charge(op_rec: OpRecord) -> None:
    held = current_caller().command_sink
    if held is not None:
        command, mine = held
        mine.append(op_rec)
        if command is not None and command is not mine:
            command.append(op_rec)


def record(
    op: str,
    path: str,
    source: str,
    nbytes: int,
    timer: OpTimer,
    fingerprint: str | None = None,
    revision: str | None = None,
) -> None:
    """Record a byte transfer event. No-op if no recording context is active.

    Args:
        op (str): Operation name ("read", "write").
        path (str): The full virtual path.
        source (str): VFS name ("s3", "ram", "disk").
        nbytes (int): Bytes transferred.
        timer (OpTimer): the timer opened by :func:`start_op` when the
            op started.
        fingerprint (str | None): Content-derived identifier returned by
            the backend (ETag, md5). Used for drift detection at replay.
        revision (str | None): Stable revision handle returned by the
            backend (S3 ``VersionId``, Drive ``revisionId``, Git SHA).
            Used to pin replay reads to the exact recorded version.
    """
    rec = current_caller().recorder
    if rec is None:
        return
    op_rec = finish_record(
        op,
        path,
        source,
        nbytes,
        timer,
        fingerprint=fingerprint,
        revision=revision,
    )
    rec.sink.append(op_rec)
    _charge(op_rec)


def record_stream(
    op: str,
    path: str,
    source: str,
    fingerprint: str | None = None,
    revision: str | None = None,
) -> OpRecord | None:
    """Start recording a streaming transfer. Returns a mutable OpRecord.

    The caller updates ``rec.bytes`` as chunks flow through. The record
    is appended to the active recorder immediately so it captures
    partial consumption (e.g., head stopping early). The caller may
    also assign ``rec.fingerprint`` / ``rec.revision`` after the initial
    GET response is available; passing them here is a shortcut for the
    common case where the values are known up front.

    Returns ``None`` if no recording context is active.

    Args:
        op (str): Operation name ("read", "write").
        path (str): The full virtual path.
        source (str): VFS name ("s3", "ram", "disk").
        fingerprint (str | None): Initial fingerprint; the caller can
            also set ``rec.fingerprint`` later.
        revision (str | None): Initial revision; the caller can also set
            ``rec.revision`` later.

    Returns:
        OpRecord | None: Mutable record, or None if not recording.
    """
    rec = current_caller().recorder
    if rec is None:
        return None
    op_rec = OpRecord(
        op=op,
        path=path,
        source=source,
        bytes=0,
        timestamp=int(rec.clock.now() * 1000),
        duration_ms=0,
        fingerprint=fingerprint,
        revision=revision,
        mount_id=rec.mount_id,
        execution_id=current_execution_id(),
    )
    rec.sink.append(op_rec)
    _charge(op_rec)
    return op_rec


def _set_revisions(revisions: dict[str, str] | None) -> CallerToken:
    return bind_caller(replace(current_caller(), revisions=revisions))


def push_revisions(revisions: dict[str, str] | None) -> CallerToken:
    """Set the active revision map for the current async context.

    Read functions consult :func:`revision_for` to look up whether a
    given virtual path should be pinned to a specific backend revision
    on replay. Mount entry points push their ``revisions`` map here
    before dispatching, so any read fired inside the mount's command or
    op handler sees the pin without explicit threading.

    Returns the token from ``ContextVar.set`` so callers can restore
    the previous state via :func:`reset_revisions`. Task-isolated: the
    ContextVar copy is per-task, so concurrent mounts don't see each
    other's pins.

    Args:
        revisions (dict[str, str] | None): Mapping of virtual path to
            backend revision. None clears the active map.

    Returns:
        Token: passable to ``reset_revisions``.
    """
    return _set_revisions(revisions)


def reset_revisions(token: CallerToken) -> None:
    """Restore the previous revisions map after a :func:`push_revisions`.

    Args:
        token (CallerToken): The token returned by ``push_revisions``.
    """
    reset_caller(token)


def revision_for(path: str) -> str | None:
    """Return the revision pin for ``path`` if one is active.

    Args:
        path (str): Virtual path, mount prefix included.

    Returns:
        str | None: The pinned revision, or None if no revisions
        context is active or the path has no pin.
    """
    revs = current_caller().revisions
    if revs is None:
        return None
    return revs.get(path)
