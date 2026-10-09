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

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import (
    invalidate_after_write,
    invalidate_ancestors,
    native_condition,
    stale,
    write_condition,
)
from mirage.cache.types import WriteCondition
from mirage.core.dropbox.api import (
    copy_path,
    delete_path,
    get_metadata,
    lookup,
    refused,
)
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.constants import (
    MISSING_SOURCE,
    TAKEN,
    TAKEN_BY_FOLDER,
)
from mirage.core.dropbox.fingerprint import live_of
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.errors.fs import enoent
from mirage.errors.types import StaleWriteError
from mirage.observe.context import record, start_op
from mirage.types import PathSpec

T = TypeVar("T")


async def _measure_destination(
    tm: DropboxTokenManager, dst: PathSpec, to_path: str
) -> tuple[WriteCondition | None, str | None]:
    """The condition a copy or move onto ``dst`` carries, and its rev.

    A destination mirage holds a version of is checked before anything
    moves: one changed or gone since it was read is refused here. The rev
    returned is what clearing it sends as ``parent_rev``.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        dst (PathSpec): the destination.
        to_path (str): the destination's Dropbox path.

    Raises:
        StaleWriteError: the destination changed or went since it was read.
    """
    cond = await write_condition(dst, "copy")
    if cond is None or not cond.if_match:
        return cond, None
    entry = await lookup(tm, to_path)
    return cond, await native_condition(dst, cond, live_of(entry), "copy")


async def _clear_destination(
    tm: DropboxTokenManager,
    dst: PathSpec,
    to_path: str,
    cond: WriteCondition | None,
    rev: str | None,
) -> None:
    """Delete the file a copy or move lands on, with its rev when measured.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        dst (PathSpec): the destination.
        to_path (str): the destination's Dropbox path.
        cond (WriteCondition | None): the condition the op carries.
        rev (str | None): the rev ``_measure_destination`` found, or None.

    Raises:
        StaleWriteError: the destination changed since it was measured.
    """
    try:
        await delete_path(tm, to_path, rev)
    except DropboxApiError as exc:
        lost = await refused(dst, exc, cond, rev)
        if lost is not None:
            raise lost from exc
        raise


async def _retaken(
    exc: DropboxApiError, cond: WriteCondition | None, dst: PathSpec
) -> StaleWriteError | None:
    """The refusal for a copy or move whose cleared destination came back.

    Another writer took the name between the clear and the retry. Its file
    is not deleted a second time, and the version held stays held, so a
    retry without a read is refused again; a folder there holds no file
    version, so it keeps none. None for any other failure.

    Args:
        exc (DropboxApiError): Dropbox's answer to the retry.
        cond (WriteCondition | None): the condition the op carries.
        dst (PathSpec): the destination.
    """
    if cond is None or not exc.summary.startswith(TAKEN):
        return None
    if cond.if_match and not exc.summary.startswith(TAKEN_BY_FOLDER):
        return await stale(dst, version=cond.if_match)
    return await stale(dst, gone=True)


async def replace_onto(
    tm: DropboxTokenManager,
    src: PathSpec,
    dst: PathSpec,
    to_path: str,
    op: Callable[[], Awaitable[T]],
    may_clear: Callable[[dict[str, Any]], Awaitable[bool]],
) -> tuple[T, dict[str, Any] | None]:
    """Run a copy or move, replacing a destination that takes the name.

    The op goes first, so a source that is gone costs the destination
    nothing: Dropbox answers a missing source before a taken destination
    (measured 2026-10-08). On a taken name a destination mirage holds a
    version of is cleared with its rev, unless a folder has taken it: that
    is refused as gone, with nothing deleted. A destination it holds no
    version of is looked up and cleared plain if ``may_clear`` allows it.
    Then the op runs once more.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        src (PathSpec): the source, for ENOENT.
        dst (PathSpec): the destination.
        to_path (str): the destination's Dropbox path.
        op (Callable[[], Awaitable[T]]): the copy or move.
        may_clear (Callable[[dict[str, Any]], Awaitable[bool]]): whether
            an unmeasured destination, as looked up, may be deleted.

    Returns:
        tuple[T, dict[str, Any] | None]: the op's reply, and the
        destination it replaced when that was looked up.

    Raises:
        StaleWriteError: the destination changed, went or was retaken.
    """
    cond, rev = await _measure_destination(tm, dst, to_path)
    try:
        return await op(), None
    except DropboxApiError as exc:
        if exc.summary.startswith(MISSING_SOURCE):
            raise enoent(src.virtual) from exc
        if not exc.summary.startswith(TAKEN):
            raise
        existing: dict[str, Any] | None = None
        if rev is None:
            existing = await get_metadata(tm, to_path)
            if not await may_clear(existing):
                raise
        elif exc.summary.startswith(TAKEN_BY_FOLDER):
            raise await stale(dst, gone=True) from exc
        await _clear_destination(tm, dst, to_path, cond, rev)
        try:
            return await op(), existing
        except DropboxApiError as again:
            if again.summary.startswith(MISSING_SOURCE):
                raise enoent(src.virtual) from again
            lost = await _retaken(again, cond, dst)
            if lost is not None:
                raise lost from again
            raise


async def not_a_folder(existing: dict[str, Any]) -> bool:
    """Whether a looked-up destination is anything but a folder.

    Args:
        existing (dict[str, Any]): the destination's metadata.
    """
    return existing.get(".tag") != "folder"


async def copy(
    accessor: DropboxAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """copy_v2 copies files and folder subtrees server-side; an existing
    destination FILE is replaced like GNU cp (see ``replace_onto``).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        src (PathSpec): source path.
        dst (PathSpec): destination path.
    """
    from_path = dropbox_path_of(accessor, src)
    to_path = dropbox_path_of(accessor, dst)
    tm = accessor.token_manager
    timer = start_op()
    await replace_onto(
        tm,
        src,
        dst,
        to_path,
        lambda: copy_path(tm, from_path, to_path),
        not_a_folder,
    )
    record("copy", dst.virtual, "dropbox", 0, timer)
    await invalidate_after_write(dst)
    await invalidate_ancestors(dst)
