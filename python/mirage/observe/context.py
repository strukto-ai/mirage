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
from collections.abc import AsyncIterator
from contextvars import ContextVar
from dataclasses import dataclass, field

from mirage.observe.record import OpRecord


@dataclass(frozen=True)
class Recorder:
    """Active recording state for a session.

    Bundles the sink (shared by reference across all push frames) with
    the mount_prefix for the current async frame. Frozen so each push
    is task-isolated: ``push_mount_prefix`` creates a new Recorder for
    the calling task via ``_recorder.set``, never mutates the parent.
    The sink list is the one piece that's intentionally shared, so
    records emitted from any frame land in the same collection.

    Args:
        sink (list[OpRecord]): Where new records are appended.
        mount_prefix (str): Current frame's mount prefix (e.g. "/s3").
            Empty when no mount is active.
        mount_id (str | None): Identity of the mounted instance serving reads.
    """

    sink: list[OpRecord] = field(default_factory=list)
    mount_prefix: str = ""
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
            rec = Recorder()
            self.records = rec.sink
            self._token = _recorder.set(rec)

    def close(self) -> None:
        """Restore the previous recorder. Idempotent."""
        if self._token is not None:
            _recorder.reset(self._token)
            self._token = None


def active_recorder() -> Recorder | None:
    """Return the active Recorder for the current async context, if any."""
    return _recorder.get()


def set_active_recorder(rec: Recorder | None):
    """Bind ``rec`` as the active Recorder for the current context.

    The door for a caller that captured a recorder on one task and must
    re-establish it on another (``RuntimeVFS`` re-binding the typed
    line's ledger around a guest op that hopped threads). Returns the
    token for :func:`reset_active_recorder`.

    Args:
        rec (Recorder | None): the recorder to bind; None binds the
            unrecorded state.
    """
    return _recorder.set(rec)


def reset_active_recorder(token) -> None:
    """Restore the previous recorder after a :func:`set_active_recorder`.

    Args:
        token: The token returned by ``set_active_recorder``.
    """
    _recorder.reset(token)


def push_mount_prefix(prefix: str) -> str:
    """Set the mount prefix on the active Recorder. Returns the previous
    prefix so callers can restore it.

    Task-isolated: replaces the Recorder for the current task via
    ``_recorder.set`` (the new Recorder shares the same sink list, so
    records still aggregate together). Other tasks reading the
    Recorder via their own contextvar copy continue to see their
    previous prefix.

    No-op (and returns "") when no recorder is active.

    Args:
        prefix (str): Mount prefix (e.g. "/s3"). Empty string to clear.

    Returns:
        str: The prefix that was active before this call.
    """
    rec = _recorder.get()
    if rec is None:
        return ""
    _recorder.set(
        Recorder(sink=rec.sink, mount_prefix=prefix, mount_id=rec.mount_id))
    return rec.mount_prefix


def push_mount_context(prefix: str, mount_id: str | None):
    """Bind the mount instance that owns reads in this async frame.

    Args:
        prefix (str): virtual mount prefix.
        mount_id (str | None): instance identity, absent outside a mount.
    """
    rec = _recorder.get()
    return _recorder.set(None if rec is None else Recorder(
        sink=rec.sink, mount_prefix=prefix, mount_id=mount_id))


async def with_mount_prefix(
        prefix: str,
        it: AsyncIterator[bytes],
        mount_id: str | None = None) -> AsyncIterator[bytes]:
    """Wrap an async iterator so the recorder's mount prefix is `prefix`
    during each ``__anext__`` of the underlying stream.

    Mirrors the side-effect-on-iteration pattern used by
    ``exit_on_empty``. Lets dispatchers preserve resource backends as
    ``async def with yield`` while still capturing the correct mount
    prefix in records emitted lazily during stream consumption.

    Args:
        prefix (str): Mount prefix to push during iteration.
        it (AsyncIterator[bytes]): The stream to wrap.
        mount_id (str | None): Captured mount identity for lazy reads.
    """
    aiter = it.__aiter__()
    try:
        while True:
            previous = _recorder.get()
            token = push_mount_context(
                prefix, mount_id if mount_id is not None else
                previous.mount_id if previous else None)
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


def _virtual(path: str, prefix: str) -> str:
    """Name `path` against `prefix`, leaving an already-virtual path alone.

    Backends name the mount-relative path ("/report.json") and a few name
    the virtual one already ("/s3/report.json"), so the two have to be told
    apart. The test is for a path boundary, not a bare startswith: a mount
    at /s3 holding s3-report.txt would otherwise look already-prefixed and
    record as "/s3-report.txt".

    Args:
        path (str): Mount-relative or already-virtual path.
        prefix (str): Mount prefix (e.g. "/s3"), empty for the root mount.
    """
    if not prefix or path == prefix or path.startswith(prefix + "/"):
        return path
    return prefix + path


class OpTimer:
    """A running stopwatch for one op, owned by the record path.

    Opened where the backend work begins and read once when the op
    finishes, so an op module hands this around instead of reading a
    clock of its own. The wall-clock stamp the record carries is taken
    at finish time, not here.
    """

    __slots__ = ("_start_ms", )

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


def finish_record(op: str,
                  path: str,
                  source: str,
                  nbytes: int,
                  timer: OpTimer,
                  fingerprint: str | None = None,
                  revision: str | None = None) -> OpRecord:
    """Close ``timer`` and build the finished record.

    The one place an op's duration and wall-clock stamp are read, shared
    by the recorder sink (:func:`record`) and by the ``Ops`` facade's own
    ledger, so the two cannot disagree about what a duration measures.

    Args:
        op (str): Operation name ("read", "write").
        path (str): The path to name the record with, as it should be
            stored (callers that need mount prefixing apply it first).
        source (str): Resource name ("s3", "ram", "disk").
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


def record(op: str,
           path: str,
           source: str,
           nbytes: int,
           timer: OpTimer,
           fingerprint: str | None = None,
           revision: str | None = None) -> None:
    """Record a byte transfer event. No-op if no recording context is active.

    Args:
        op (str): Operation name ("read", "write").
        path (str): Resource-relative path.
        source (str): Resource name ("s3", "ram", "disk").
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
    prefix = rec.mount_prefix
    rec.sink.append(
        finish_record(op,
                      _virtual(path, prefix),
                      source,
                      nbytes,
                      timer,
                      fingerprint=fingerprint,
                      revision=revision))


def record_stream(op: str,
                  path: str,
                  source: str,
                  fingerprint: str | None = None,
                  revision: str | None = None) -> OpRecord | None:
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
        path (str): Resource-relative path.
        source (str): Resource name ("s3", "ram", "disk").
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
    prefix = rec.mount_prefix
    op_rec = OpRecord(
        op=op,
        path=_virtual(path, prefix),
        source=source,
        bytes=0,
        timestamp=int(time.time() * 1000),
        duration_ms=0,
        fingerprint=fingerprint,
        revision=revision,
        mount_id=rec.mount_id,
    )
    rec.sink.append(op_rec)
    return op_rec


_revisions: ContextVar[dict[str, str] | None] = ContextVar("_revisions",
                                                           default=None)


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


async def with_revisions(revisions: dict[str, str] | None,
                         it: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Wrap an async iterator so the active revisions map is ``revisions``
    during each ``__anext__`` of the underlying stream.

    Mirrors :func:`with_mount_prefix`. A command handler can return an
    async generator that defers its backend ``read_stream`` call to the
    first chunk request; by the time the caller consumes it, the
    dispatcher's ``revisions`` context would otherwise have been reset.
    Wrapping with this restores the pins on every iteration.

    Args:
        revisions (dict[str, str] | None): Revisions to push during
            iteration.
        it (AsyncIterator[bytes]): The stream to wrap.
        mount_id (str | None): Captured mount identity for lazy reads.
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
