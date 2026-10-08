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

import time
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

from mirage.observe.record import STAMP_FINGERPRINT_OPS, OpRecord, RecordIndex
from mirage.utils.key_prefix import under_path


@dataclass
class LostPaths:
    """The paths whose conditional write lost on this line.

    A lost path's cached copy was dropped; nothing the line read of it
    before the loss may be cached again. The version the write lost on is
    the one a retry sends, so it is refused again until a read. A read or
    write of the path after the loss names the bytes now there, and lifts
    the mark, as does removing or moving it away.

    Args:
        sink (list[OpRecord]): the line's records, shared with its frames.
        marks (dict[str, int]): each lost path and where in ``sink`` it
            was lost.
        versions (dict[str, str]): each lost path's refused version.
        order (dict[str, int]): each lost path's mark, numbered in order.
        count (int): the marks made so far.
    """

    sink: list[OpRecord]
    marks: dict[str, int] = field(default_factory=dict)
    versions: dict[str, str] = field(default_factory=dict)
    order: dict[str, int] = field(default_factory=dict)
    count: int = 0

    def mark(self, key: str, version: str | None = None) -> None:
        """Record that a conditional write to ``key`` lost.

        Args:
            key (str): the virtual path.
            version (str | None): the version it lost on, if any.
        """
        self.marks[key] = len(self.sink)
        self.count += 1
        self.order[key] = self.count
        if version:
            self.versions[key] = version
        else:
            self.versions.pop(key, None)

    def lift(self, key: str, upto: int, subtree: bool = False) -> None:
        """Lift the marks a removal or move of ``key`` made stale.

        Only marks made by the time it began: a refusal another command of
        the line made while it ran is newer than it, and stays.

        Args:
            key (str): the virtual path removed or moved.
            upto (int): ``count`` when the removal or move began.
            subtree (bool): the paths below it went too.
        """
        for marked in [
            k
            for k in self.marks
            if (k == key or subtree and under_path(k, key))
            and self.order[k] <= upto
        ]:
            del self.marks[marked]
            self.versions.pop(marked, None)
            del self.order[marked]

    def version(self, key: str) -> str | None:
        """The version a write to ``key`` lost on, while it is still lost.

        Args:
            key (str): the virtual path.
        """
        return self.versions.get(key) if self.holds(key) else None

    def holds(self, key: str) -> bool:
        """Whether ``key`` is lost and nothing since has read or written it.

        Args:
            key (str): the virtual path.
        """
        start = self.marks.get(key)
        if start is None:
            return False
        return not any(
            rec.path == key and rec.op in STAMP_FINGERPRINT_OPS
            for rec in self.sink[start:]
        )


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


@dataclass(frozen=True)
class Recorder:
    """Active recording state for a session.

    Bundles the sink (shared by reference across all push frames) with
    the mount_id for the current async frame. Frozen so each push is
    task-isolated: ``push_mount_context`` creates a new Recorder for
    the calling task via ``_recorder.set``, never mutates the parent.
    The sink list is the one piece that's intentionally shared, so
    records emitted from any frame land in the same collection.

    Args:
        sink (list[OpRecord]): Where new records are appended.
        lost (LostPaths): The line's lost paths.
        index (RecordIndex): The line's version index over ``sink``.
        mount_id (str | None): Identity of the mounted instance serving reads.
    """

    sink: list[OpRecord]
    lost: LostPaths
    index: RecordIndex
    mount_id: str | None = None


_recorder: ContextVar[Recorder | None] = ContextVar("_recorder", default=None)


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
    """

    def __init__(self, active: bool = True) -> None:
        self.records: list[OpRecord] = []
        self._token = None
        if active:
            sink: list[OpRecord] = []
            rec = Recorder(
                sink=sink, lost=LostPaths(sink), index=RecordIndex(sink)
            )
            self.records = rec.sink
            self._token = _recorder.set(rec)

    def close(self) -> None:
        """Restore the previous recorder. Idempotent."""
        if self._token is not None:
            _recorder.reset(self._token)
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
    rec = _recorder.get()
    return rec.sink if rec is not None else None


_command_sink: ContextVar[list[OpRecord] | None] = ContextVar(
    "_command_sink", default=None
)


@contextmanager
def command_records() -> Iterator[list[OpRecord]]:
    """Collect the records the running command itself emits.

    Yields a fresh list that :func:`record` and :func:`record_stream`
    append to, beside the line's sink, while the block runs. A nested
    block opens its own list, and a concurrent task keeps the list its
    context was copied with, so a pipeline stage never sees a sibling
    stage's records. Nothing is collected outside a recording scope.

    Yields:
        list[OpRecord]: the command's own records, shared with the
        line's sink.
    """
    mine: list[OpRecord] = []
    token = _command_sink.set(mine)
    try:
        yield mine
    finally:
        _command_sink.reset(token)


def active_lost() -> LostPaths | None:
    """The running line's lost paths, None outside a recorded line."""
    rec = _recorder.get()
    return rec.lost if rec is not None else None


def mark_lost(key: str, version: str | None = None) -> None:
    """Mark ``key`` lost on the running line, if one is recording.

    Args:
        key (str): the virtual path whose conditional write lost.
        version (str | None): the version it lost on, if any.
    """
    lost = active_lost()
    if lost is not None:
        lost.mark(key, version)


def lost_count() -> int:
    """The running line's marks so far, for a later :func:`lift_lost`."""
    lost = active_lost()
    return lost.count if lost is not None else 0


def lift_lost(key: str, upto: int, subtree: bool = False) -> None:
    """Lift the running line's marks a removal or move of ``key`` ended.

    Args:
        key (str): the virtual path removed or moved.
        upto (int): :func:`lost_count` when the removal or move began.
        subtree (bool): the paths below it went too.
    """
    lost = active_lost()
    if lost is not None:
        lost.lift(key, upto, subtree)


def active_recorder() -> Recorder | None:
    """Return the active Recorder for the current async context, if any."""
    return _recorder.get()


def reset_active_recorder(token) -> None:
    """Restore the previous recorder after a :func:`push_mount_context`.

    Args:
        token: The token returned by ``push_mount_context``.
    """
    _recorder.reset(token)


def push_mount_context(mount_id: str | None):
    """Bind the mount instance that owns records in this async frame.

    Task-isolated: replaces the Recorder for the current task via
    ``_recorder.set`` (the new Recorder shares the same sink list, so
    records still aggregate together). Binds the unrecorded state again
    when no recorder is active. Returns the token for
    :func:`reset_active_recorder`.

    Args:
        mount_id (str | None): instance identity, absent outside a mount.
    """
    rec = _recorder.get()
    return _recorder.set(
        None
        if rec is None
        else Recorder(
            sink=rec.sink, mount_id=mount_id, lost=rec.lost, index=rec.index
        )
    )


async def with_mount_context(
    it: AsyncIterator[bytes], mount_id: str | None = None
) -> AsyncIterator[bytes]:
    """Wrap an async iterator so the recorder's mount_id is ``mount_id``
    during each ``__anext__`` of the underlying stream.

    Mirrors the side-effect-on-iteration pattern used by
    ``exit_on_empty``. Lets dispatchers preserve VFS backends as
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
            previous = _recorder.get()
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
    at finish time, not here.
    """

    __slots__ = ("_start_ms",)

    def __init__(self) -> None:
        self._start_ms = int(time.monotonic() * 1000)

    @property
    def elapsed_ms(self) -> int:
        """Milliseconds elapsed since the timer was opened."""
        return int(time.monotonic() * 1000) - self._start_ms


def start_op() -> OpTimer:
    """Open the record path's stopwatch for one op.

    Returns:
        OpTimer: a running timer, to hand to :func:`record` or
        :func:`finish_record` when the op completes.
    """
    return OpTimer()


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

    The one place an op's duration and wall-clock stamp are read, shared
    by the recorder sink (:func:`record`) and by the ``Ops`` facade's own
    ledger, so the two cannot disagree about what a duration measures.

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
    recorder = _recorder.get()
    return OpRecord(
        op=op,
        path=path,
        source=source,
        bytes=nbytes,
        timestamp=int(time.time() * 1000),
        duration_ms=elapsed,
        fingerprint=fingerprint,
        revision=revision,
        mount_id=recorder.mount_id if recorder is not None else None,
    )


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
    rec = _recorder.get()
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
    mine = _command_sink.get()
    if mine is not None:
        mine.append(op_rec)


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
    rec = _recorder.get()
    if rec is None:
        return None
    op_rec = OpRecord(
        op=op,
        path=path,
        source=source,
        bytes=0,
        timestamp=int(time.time() * 1000),
        duration_ms=0,
        fingerprint=fingerprint,
        revision=revision,
        mount_id=rec.mount_id,
    )
    rec.sink.append(op_rec)
    mine = _command_sink.get()
    if mine is not None:
        mine.append(op_rec)
    return op_rec


_revisions: ContextVar[dict[str, str] | None] = ContextVar(
    "_revisions", default=None
)


def push_revisions(revisions: dict[str, str] | None):
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
    return _revisions.set(revisions)


def reset_revisions(token) -> None:
    """Restore the previous revisions map after a :func:`push_revisions`.

    Args:
        token: The token returned by ``push_revisions``.
    """
    _revisions.reset(token)


def revision_for(path: str) -> str | None:
    """Return the revision pin for ``path`` if one is active.

    Args:
        path (str): Virtual path, mount prefix included.

    Returns:
        str | None: The pinned revision, or None if no revisions
        context is active or the path has no pin.
    """
    revs = _revisions.get()
    if revs is None:
        return None
    return revs.get(path)


async def with_revisions(
    revisions: dict[str, str] | None, it: AsyncIterator[bytes]
) -> AsyncIterator[bytes]:
    """Wrap an async iterator so the active revisions map is ``revisions``
    during each ``__anext__`` of the underlying stream.

    Mirrors :func:`with_mount_context`. A command handler can return an
    async generator that defers its backend ``read_stream`` call to the
    first chunk request; by the time the caller consumes it, the
    dispatcher's ``revisions`` context would otherwise have been reset.
    Wrapping with this restores the pins on every iteration.

    Args:
        revisions (dict[str, str] | None): Revisions to push during
            iteration.
        it (AsyncIterator[bytes]): The stream to wrap.
    """
    aiter = it.__aiter__()
    try:
        while True:
            token = push_revisions(revisions)
            try:
                chunk = await aiter.__anext__()
            except StopAsyncIteration:
                return
            finally:
                reset_revisions(token)
            yield chunk
    finally:
        close = getattr(aiter, "aclose", None)
        if close is not None:
            await close()
