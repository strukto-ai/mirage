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
from typing import Any, TypeVar
from uuid import uuid4

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import (
    condition_version,
    native_condition,
    stale,
    write_condition,
)
from mirage.cache.types import WriteCondition
from mirage.core.dropbox.api import (
    copy_path,
    delete_path,
    get_metadata,
    list_folder,
    lookup,
    move_path,
    refused,
)
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.constants import (
    MISSING_SOURCE,
    TAKEN,
    TAKEN_BY_FOLDER,
)
from mirage.core.dropbox.fingerprint import live_of
from mirage.core.dropbox.paths import check_path, dropbox_path_of
from mirage.errors.fs import enoent, enotempty
from mirage.errors.types import StaleWriteError
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec

logger = logging.getLogger(__name__)

T = TypeVar("T")


async def _retaken(
    exc: DropboxApiError, cond: WriteCondition | None, dst: PathSpec
) -> StaleWriteError | None:
    """The refusal for a copy or move whose cleared destination came back.

    The condition the op sent stays held, whatever took the name.

    Args:
        exc (DropboxApiError): Dropbox's answer to the retry.
        cond (WriteCondition | None): the condition the op carries.
        dst (PathSpec): the destination.
    """
    if cond is None or not exc.summary.startswith(TAKEN):
        return None
    return await stale(dst, version=condition_version(cond))


async def _clear(
    tm: DropboxTokenManager,
    dst: PathSpec,
    to_path: str,
    rev: str | None,
    existing: dict[str, Any] | None,
) -> None:
    """Delete what holds the destination name, once the op landed beside it.

    A folder is asked for a child again first, so one written while the
    op landed is not deleted with it: mv's "Directory not empty".

    Args:
        tm (DropboxTokenManager): the account's token manager.
        dst (PathSpec): the destination, for ENOTEMPTY.
        to_path (str): its Dropbox path.
        rev (str | None): the rev the delete is held to.
        existing (dict[str, Any] | None): what the lookup found there.
    """
    if (
        existing is not None
        and existing.get(".tag") == "folder"
        and await list_folder(tm, to_path, limit=1)
    ):
        raise enotempty(dst)
    await delete_path(tm, to_path, rev)


async def replace_onto(
    tm: DropboxTokenManager,
    src: PathSpec,
    dst: PathSpec,
    to_path: str,
    op: Callable[[str], Awaitable[T]],
    undo: Callable[[str], Awaitable[Any]],
    empty_folder: bool,
) -> tuple[T, dict[str, Any] | None]:
    """Run a copy or move, replacing a file that holds the destination name.

    The op goes first, since Dropbox answers a missing source before a
    taken name. A held destination is measured before the op, cleared with
    its rev on a taken name, and refused as gone when a folder took it. On
    a taken name the op lands under a staged name beside the destination,
    what holds the name goes next, and the landed entry takes the name
    last: a refused op leaves the destination as it was, and a refused
    delete hands the landed entry to ``undo``.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        src (PathSpec): the source, for ENOENT.
        dst (PathSpec): the destination.
        to_path (str): the destination's Dropbox path.
        op (Callable[[str], Awaitable[T]]): the copy or move to a path.
        undo (Callable[[str], Awaitable[Any]]): what takes back an entry
            the op landed at a path.
        empty_folder (bool): whether an empty folder there gives way too.

    Returns:
        tuple[T, dict[str, Any] | None]: the op's reply, and the
        destination it replaced when that was looked up.
    """
    cond = await write_condition(dst, "copy")
    rev = None
    if cond is not None and condition_version(cond):
        live = live_of(await lookup(tm, to_path))
        rev = await native_condition(dst, cond, live, "copy")
    existing: dict[str, Any] | None = None
    try:
        return await op(to_path), None
    except DropboxApiError as exc:
        if exc.summary.startswith(MISSING_SOURCE):
            raise enoent(src.virtual) from exc
        if not exc.summary.startswith(TAKEN):
            raise
        if rev is None:
            existing = await get_metadata(tm, to_path)
            if existing.get(".tag") == "folder" and not (
                empty_folder and not await list_folder(tm, to_path, limit=1)
            ):
                raise
        elif exc.summary.startswith(TAKEN_BY_FOLDER):
            raise await stale(dst) from exc
    staged = f"{to_path}.mirage-{uuid4().hex}"
    try:
        landed = await op(staged)
    except DropboxApiError as again:
        if again.summary.startswith(MISSING_SOURCE):
            raise enoent(src.virtual) from again
        raise
    try:
        await _clear(tm, dst, to_path, rev, existing)
    except Exception as err:
        await _take_back(undo, staged)
        if isinstance(err, DropboxApiError):
            raise (await refused(dst, err, cond, rev)) or err
        raise
    try:
        await move_path(tm, staged, to_path)
    except Exception as again:
        await _take_back(undo, staged)
        if isinstance(again, DropboxApiError):
            raise (await _retaken(again, cond, dst)) or again
        raise
    return landed, existing


async def _take_back(
    undo: Callable[[str], Awaitable[Any]], staged: str
) -> None:
    """Hand an entry the op landed to ``undo``; a refusal is logged, so
    the error that called for it stays the one raised.

    Args:
        undo (Callable[[str], Awaitable[Any]]): what takes it back.
        staged (str): where the op landed it.
    """
    try:
        await undo(staged)
    except Exception as exc:
        logger.debug("could not take back %s: %s", staged, exc)


async def copy(
    accessor: DropboxAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """copy_v2 copies files and folder subtrees server-side; an existing
    destination FILE is replaced, as cp does (see ``replace_onto``).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        src (PathSpec): source path.
        dst (PathSpec): destination path.
    """
    await check_path(accessor, src)
    await check_path(accessor, dst)
    from_path = dropbox_path_of(accessor, src)
    to_path = dropbox_path_of(accessor, dst)
    tm = accessor.token_manager
    upto = lost_count()
    timer = start_op()
    await replace_onto(
        tm,
        src,
        dst,
        to_path,
        lambda to: copy_path(tm, from_path, to),
        lambda staged: delete_path(tm, staged),
        empty_folder=False,
    )
    record("copy", dst.virtual, "dropbox", 0, timer)
    lift_lost(dst, upto)


async def dir_copy(
    accessor: DropboxAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """Copy a folder tree onto a fresh name in one copy_v2.

    ``cp -r`` asks this only when nothing holds ``dst``, so a taken name
    is Dropbox's conflict, never a merge.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        src (PathSpec): the folder.
        dst (PathSpec): the copy.
    """
    await check_path(accessor, src)
    await check_path(accessor, dst)
    tm = accessor.token_manager
    upto = lost_count()
    timer = start_op()
    try:
        await copy_path(
            tm, dropbox_path_of(accessor, src), dropbox_path_of(accessor, dst)
        )
    except DropboxApiError as exc:
        if exc.summary.startswith(MISSING_SOURCE):
            raise enoent(src.virtual) from exc
        raise
    record("copy_prefix", dst.virtual, "dropbox", 0, timer)
    lift_lost(dst, upto, subtree=True)
