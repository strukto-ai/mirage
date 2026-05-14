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
    """

    sink: list[OpRecord] = field(default_factory=list)
    mount_prefix: str = ""


_recorder: ContextVar[Recorder | None] = ContextVar("_recorder", default=None)


def start_recording() -> list[OpRecord]:
    """Activate byte recording for the current async context.

    Returns:
        list[OpRecord]: The list that will collect records.
    """
    rec = Recorder()
    _recorder.set(rec)
    return rec.sink


def stop_recording() -> None:
    """Deactivate byte recording for the current async context."""
    _recorder.set(None)


def active_recorder() -> Recorder | None:
    """Return the active Recorder for the current async context, if any."""
    return _recorder.get()


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
    _recorder.set(Recorder(sink=rec.sink, mount_prefix=prefix))
    return rec.mount_prefix


async def with_mount_prefix(prefix: str,
                            it: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Wrap an async iterator so the recorder's mount prefix is `prefix`
    during each ``__anext__`` of the underlying stream.

    Mirrors the side-effect-on-iteration pattern used by
    ``exit_on_empty``. Lets dispatchers preserve resource backends as
    ``async def with yield`` while still capturing the correct mount
    prefix in records emitted lazily during stream consumption.

    Args:
        prefix (str): Mount prefix to push during iteration.
        it (AsyncIterator[bytes]): The stream to wrap.
    """
    aiter = it.__aiter__()
    while True:
        prev = push_mount_prefix(prefix)
        try:
            chunk = await aiter.__anext__()
        except StopAsyncIteration:
            push_mount_prefix(prev)
            return
        push_mount_prefix(prev)
        yield chunk


def _virtual(path: str, prefix: str) -> str:
    if prefix and not path.startswith(prefix):
        return prefix + path
    return path


def record(op: str,
           path: str,
           source: str,
           nbytes: int,
           start_ms: int,
           fingerprint: str | None = None,
           revision: str | None = None) -> None:
    """Record a byte transfer event. No-op if no recording context is active.

    Args:
        op (str): Operation name ("read", "write").
        path (str): Resource-relative path.
        source (str): Resource name ("s3", "ram", "disk").
        nbytes (int): Bytes transferred.
        start_ms (int): Monotonic start time in milliseconds.
        fingerprint (str | None): Content-derived identifier returned by
            the backend (ETag, md5). Used for drift detection at replay.
        revision (str | None): Stable revision handle returned by the
            backend (S3 ``VersionId``, Drive ``revisionId``, Git SHA).
            Used to pin replay reads to the exact recorded version.
    """
    rec = _recorder.get()
    if rec is None:
        return
    elapsed = int(time.monotonic() * 1000) - start_ms
    prefix = rec.mount_prefix
    rec.sink.append(
        OpRecord(
            op=op,
            path=_virtual(path, prefix),
            source=source,
            bytes=nbytes,
            timestamp=int(time.time() * 1000),
            duration_ms=elapsed,
            mount_prefix=prefix,
            fingerprint=fingerprint,
            revision=revision,
        ))


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
        mount_prefix=prefix,
        fingerprint=fingerprint,
        revision=revision,
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
        path (str): Virtual path (mount_prefix + rel_path).

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
    """
    aiter = it.__aiter__()
    while True:
        token = push_revisions(revisions)
        try:
            chunk = await aiter.__anext__()
        except StopAsyncIteration:
            reset_revisions(token)
            return
        reset_revisions(token)
        yield chunk
