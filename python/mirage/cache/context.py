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

import logging
from collections.abc import Awaitable, Callable
from typing import Literal, TypeVar, overload

from mirage.cache.types import (
    ABSENT_WRITE,
    ANY_WRITE,
    AbsentWrite,
    AnyWrite,
    CacheInvalidator,
    ConditionSupport,
    KnownVersions,
    LiveVersion,
    MatchWrite,
    Measured,
    OwnRead,
    WriteCondition,
    WriteContext,
    WriteKind,
)
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.errors.fs import enotsup, stale_write
from mirage.errors.types import StaleWriteError
from mirage.observe.context import mark_lost
from mirage.types import PathSpec
from mirage.utils.key_prefix import key_path

logger = logging.getLogger(__name__)

T = TypeVar("T")


def active_cache_manager() -> CacheInvalidator | None:
    """Return the active cache manager for the current async context."""
    return current_caller().cache_manager


async def settle_after(
    op: Awaitable[T], settle: Callable[[T | None], Awaitable[None]]
) -> T:
    """Run ``op``, then ``settle``, also when ``op`` fails.

    An op that fails partway (a paginated delete, a folder copy that
    merged some children) has already changed the backend, so its
    record is owed either way. ``settle`` gets the op's result, or None
    when the op failed. After a failed op a settle error is logged, not
    raised, so the caller still learns why the op failed. Failure records
    invalidate shared caches but preserve session versions for untouched files.

    Args:
        op (Awaitable[T]): The backend change.
        settle (Callable[[T | None], Awaitable[None]]): Records what the
            op changed, given its result or None.
    """
    try:
        result = await op
    except BaseException:
        token = bind_caller(current_caller().changed({"version_reads": False}))
        try:
            await settle(None)
        except Exception as exc:
            logger.debug("settling after a failed op: %s", exc)
        finally:
            reset_caller(token)
        raise
    await settle(result)
    return result


async def capture_read(
    path: str, fetch: Callable[[], Awaitable[T]]
) -> tuple[T, list[str | None]]:
    """Collect tokens belonging to the exact bytes returned by a fetch.

    Args:
        path (str): virtual cache key.
        fetch (Callable): whole-file backend reader.
    """
    facts: list[tuple[bytes, str | None]] = []
    token = bind_caller(
        current_caller().changed({"read_facts": (path, facts)})
    )
    try:
        data = await fetch()
        return data, [fp for body, fp in facts if body is data]
    finally:
        reset_caller(token)


def publish_read(path: str, data: bytes, fingerprint: str | None) -> None:
    """Publish a backend-verified token without activating observation.

    Args:
        path (str): virtual file path.
        data (bytes): the exact object the reader returns.
        fingerprint (str | None): token proven by these bytes, or unknown.
    """
    capture = current_caller().read_facts
    if capture is not None and capture[0] == path:
        capture[1].append((data, fingerprint))


async def read_versioned(
    path: PathSpec, fetch: Callable[[], Awaitable[T]]
) -> tuple[T, str | None]:
    """Run a read and return its bytes with the token they carried.

    For an op that writes back what it read: the token is the one its
    backend published for these exact bytes, None when it published none
    or published two that disagree.

    Args:
        path (PathSpec): the path read.
        fetch (Callable): the read.
    """
    data, facts = await capture_read(path.virtual, fetch)
    token = facts[0] if facts and all(f == facts[0] for f in facts) else None
    return data, token


def condition_version(condition: WriteCondition | None) -> str | None:
    return condition.version if isinstance(condition, MatchWrite) else None


def require_supported(
    support: ConditionSupport,
    vfs: str,
    path: PathSpec,
    kind: WriteKind,
    condition: WriteCondition,
) -> None:
    if isinstance(condition, AnyWrite):
        return
    mode = "absent" if isinstance(condition, AbsentWrite) else "match"
    if mode not in support.get(kind, frozenset()):
        raise enotsup(vfs, f"conditional {kind} ({mode})", path)


@overload
async def write_condition(
    path: PathSpec,
    kind: Literal["put"],
    *,
    own: str | OwnRead | None = None,
) -> WriteCondition: ...


@overload
async def write_condition(
    path: PathSpec,
    kind: Literal["copy", "delete"],
    *,
    own: str | OwnRead | None = None,
) -> WriteCondition | None: ...


async def write_condition(
    path: PathSpec,
    kind: WriteKind,
    *,
    own: str | OwnRead | None = None,
) -> WriteCondition | None:
    context = current_caller().write_context
    if context is None:
        if kind != "put":
            return None
        return ABSENT_WRITE if own is OwnRead.ABSENT else ANY_WRITE
    cached = await context.read_version(path)
    return await _settle(context, path, kind, own, cached)


async def delete_condition(
    path: PathSpec, looked_up: str | None
) -> WriteCondition | None:
    """The condition a delete of ``path`` carries, None when unconditional.

    A delete needs no read of its own, only that nobody wrote since: the
    version the mount holds, else the one its own lookup found.

    Args:
        path (PathSpec): the path deleted.
        looked_up (str | None): the version the delete's lookup found.

    Raises:
        StaleWriteError: the session found no file there, and one has
            appeared since.
        OperationNotSupportedError: the backend cannot condition a delete.
    """
    context = current_caller().write_context
    if context is None:
        return None
    cached = await context.read_version(path)
    if cached is OwnRead.ABSENT:
        if looked_up:
            raise await stale(path)
        cached = None
    return _condition(context, path, "delete", cached or looked_up)


async def move_condition(
    src: PathSpec, dst: PathSpec
) -> tuple[WriteCondition | None, str | None]:
    """The conditions a move carries: the copy onto ``dst``, the source pin.

    Both versions come from one store lookup.

    Args:
        src (PathSpec): the source, whose delete is pinned.
        dst (PathSpec): the destination, whose copy is conditioned.

    Returns:
        tuple[WriteCondition | None, str | None]: the copy's condition,
        None when unconditional, and the source's version, None without
        one.

    Raises:
        StaleWriteError: the op found removed a file the mount saw.
        OperationNotSupportedError: the backend cannot condition the move.
    """
    context = current_caller().write_context
    if context is None:
        return None, None
    dst_cached, src_cached = await context.read_versions([dst, src])
    cond = await _settle(context, dst, "copy", None, dst_cached)
    source = await _settle(context, src, "delete", None, src_cached)
    return cond, condition_version(source)


async def _settle(
    context: WriteContext,
    path: PathSpec,
    kind: WriteKind,
    own: str | OwnRead | None,
    cached: Measured | None,
) -> WriteCondition:
    if own is OwnRead.UNKNOWN:
        return _condition(context, path, kind, None)
    if own is OwnRead.ABSENT:
        if isinstance(cached, str):
            raise await stale(path)
        if kind == "put":
            return ABSENT_WRITE
        own = None
    if cached is OwnRead.ABSENT:
        if own is None and kind in context.creates:
            return ABSENT_WRITE
        cached = None
    return _condition(context, path, kind, own or cached)


def _condition(
    context: WriteContext, path: PathSpec, kind: WriteKind, version: str | None
) -> WriteCondition:
    # A put with no version goes out plain, so it needs no condition.
    if kind != "put" or version:
        _require(context, path, kind)
    return MatchWrite(version) if version else ANY_WRITE


def _require(context: WriteContext, path: PathSpec, kind: WriteKind) -> None:
    if kind not in context.conditions:
        raise enotsup(context.vfs, f"conditional {kind}", path)


async def native_condition(
    path: PathSpec,
    cond: WriteCondition | None,
    live: LiveVersion | None,
    kind: WriteKind,
) -> str | None:
    """The native token a write sends in place of the held content token.

    None when the write goes plain; the backend refuses whatever lands
    between the lookup and the write.

    Args:
        path (PathSpec): the path written.
        cond (WriteCondition | None): the condition the write carries.
        live (LiveVersion | None): the file's current tokens, None when
            the backend has no file there.
        kind (WriteKind): the op the token conditions, for the refusal.

    Raises:
        StaleWriteError: the file changed or went since it was read.
        OperationNotSupportedError: the backend gave no token to send.
    """
    if isinstance(cond, AbsentWrite):
        context = current_caller().write_context
        raise enotsup(
            context.vfs if context else "backend",
            f"conditional {kind} (absent)",
            path,
        )
    held = condition_version(cond)
    if not held:
        return None
    if live is None:
        raise await stale(path)
    if live.content != held:
        raise await stale(path, version=held)
    if not live.native:
        context = current_caller().write_context
        raise enotsup(
            context.vfs if context else "backend", f"conditional {kind}", path
        )
    return live.native


def writes_conditioned() -> bool:
    """Whether the mount running this op is a ``write: conditional`` one."""
    return current_caller().write_context is not None


def conditioned(path: PathSpec, kind: Literal["copy", "delete"]) -> bool:
    """Whether a ``kind`` on ``path`` goes out conditioned.

    For a prefix walk, which conditions each key itself and needs no
    version for the operand.

    Args:
        path (PathSpec): the operand.
        kind (Literal["copy", "delete"]): the op.

    Raises:
        OperationNotSupportedError: the backend cannot condition this op.
    """
    context = current_caller().write_context
    if context is None:
        return False
    _require(context, path, kind)
    return True


async def drop_cached(path: PathSpec, keep: Measured | None = None) -> None:
    """Drop the write context's cached copy of ``path``, if there is one.

    The line marks it lost too, so nothing it read of the path earlier is
    cached again when it ends. A refused write keeps the version it lost
    on: a retry without a read sends it again and is refused again, rather
    than going out plain over the newer file.

    Args:
        path (PathSpec): the path to drop.
        keep (Measured | None): the version to keep without bytes, ABSENT
            for a refused create, None for none.
    """
    mark_lost(path, keep if isinstance(keep, str) else None)
    context = current_caller().write_context
    if context is not None:
        await context.drop(path)
        if keep:
            await context.keep(path, keep)


async def stale(
    path: PathSpec,
    landed: bool = False,
    version: Measured | None = None,
) -> StaleWriteError:
    """The refusal for a lost condition, after dropping the cached copy.

    The condition the write sent is kept, so a retry without a read sends
    it again and is refused again. That holds for a file found gone too:
    a peer may create it again before the retry.

    Args:
        path (PathSpec): the path whose write lost.
        landed (bool): a move's copy landed before its source's delete
            lost.
        version (Measured | None): the version the write sent, when the
            line no longer names it (a move retracts both paths); ABSENT
            when the op found the file gone.
    """
    context = current_caller().write_context
    keep = None
    if context is not None:
        keep = (
            version
            if isinstance(version, str)
            else await context.read_version(path)
        )
    await drop_cached(path, keep)
    return stale_write(path, landed=landed)


async def keep_refused(
    lost: list[tuple[PathSpec, str | None]],
) -> StaleWriteError | None:
    """Keep the version of every file a walk left behind; refuse the first.

    Args:
        lost (list[tuple[PathSpec, str | None]]): each file left behind,
            with the version it lost on.

    Returns:
        StaleWriteError | None: the refusal naming the first, or None.
    """
    refusals = [await stale(spec, version=version) for spec, version in lost]
    return refusals[0] if refusals else None


async def held_versions(paths: list[PathSpec]) -> list[str | None]:
    """The version the mount holds for each path, in one store round trip.

    Args:
        paths (list[PathSpec]): the paths, in order.
    """
    context = current_caller().write_context
    if context is None or not paths:
        return [None] * len(paths)
    return [
        tok if isinstance(tok, str) else None
        for tok in await context.read_versions(paths)
    ]


def known_versions(root: PathSpec, key_prefix: str) -> KnownVersions:
    """The versions a prefix walk under ``root`` measures its keys against.

    A key the agent read is held to the version it read; the walk's own
    listing only stands in for keys it never saw.

    Args:
        root (PathSpec): the walk's operand, for addressing its keys.
        key_prefix (str): the mount's backend key prefix.
    """

    async def known(keys: list[str]) -> dict[str, str]:
        context = current_caller().write_context
        if context is None or not keys:
            return {}
        tokens = await context.read_versions(
            [key_path(root, key_prefix, key) for key in keys]
        )
        return {
            key: tok for key, tok in zip(keys, tokens) if isinstance(tok, str)
        }

    return known
