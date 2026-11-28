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

from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeVar

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import (
    condition_version,
    native_condition,
    stale,
    write_condition,
)
from mirage.cache.types import WriteCondition
from mirage.core.api.replace import aside_name, land_then_retire, set_aside
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
    CONTENT_HASH,
    MISSING_SOURCE,
    REV,
    TAKEN,
    TAKEN_BY_FOLDER,
)
from mirage.core.dropbox.fingerprint import live_of, token_of
from mirage.core.dropbox.paths import check_path, dropbox_path_of
from mirage.errors.fs import enoent, enotempty
from mirage.errors.types import StaleWriteError
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec

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


async def _move_aside(
    tm: DropboxTokenManager,
    dst: PathSpec,
    to_path: str,
    aside: str,
    folder: bool,
    content: str | None,
) -> dict[str, Any]:
    """Move what holds the destination aside, refusing one that changed.

    Dropbox moves on no condition, so what moved is checked after: a
    file must still carry the content read, a folder must still be one.
    A refusal here comes after the move, so ``set_aside`` moves it back.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        dst (PathSpec): the destination, for the refusal.
        to_path (str): its Dropbox path.
        aside (str): where it moves.
        folder (bool): whether it was a folder.
        content (str | None): the content token a file was read with.

    Returns:
        dict[str, Any]: what moved aside, as the move answered it.
    """
    moved = await move_path(tm, to_path, aside)
    if folder:
        kept = moved.get(".tag") == "folder"
    else:
        kept = moved.get(".tag") == "file" and (
            content is None or token_of(moved.get(CONTENT_HASH)) == content
        )
    if not kept:
        raise await stale(dst)
    return moved


async def _retire(
    tm: DropboxTokenManager,
    dst: PathSpec,
    aside: str,
    moved: Mapping[str, Any],
    cond: WriteCondition | None,
) -> None:
    """Delete what was set aside: a file held to the rev its move
    answered, a folder only while it lists no child, so one written while
    the op landed is not deleted with it: mv's "Directory not empty".

    Args:
        tm (DropboxTokenManager): the account's token manager.
        dst (PathSpec): the destination, for ENOTEMPTY.
        aside (str): where it was set aside.
        moved (dict[str, Any]): what moved there, as the move answered it.
        cond (WriteCondition | None): the op's condition.
    """
    if moved.get(".tag") == "folder":
        if await list_folder(tm, aside, limit=1):
            raise enotempty(dst)
        await delete_path(tm, aside)
        return
    rev = token_of(moved.get(REV))
    try:
        await delete_path(tm, aside, rev)
    except DropboxApiError as exc:
        raise (await refused(dst, exc, cond, rev)) or exc


async def replace_onto(
    tm: DropboxTokenManager,
    src: PathSpec,
    dst: PathSpec,
    to_path: str,
    op: Callable[[str], Awaitable[T]],
    undo: Callable[[str, T], Awaitable[Any]],
    empty_folder: bool,
) -> tuple[T, dict[str, Any] | None]:
    """Run a copy or move, replacing what holds the destination name.

    The op goes first, since Dropbox answers a missing source before a
    taken name. On a taken name, what holds it (a file, or an empty
    folder where ``empty_folder``) moves aside under a staged name, the
    op lands on the name, and what moved aside is deleted last. A held
    destination is measured before the op and refused as gone when a
    folder took it. A refused or lost step puts both back
    (``land_then_retire``), handing a landing to ``undo``.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        src (PathSpec): the source, for ENOENT.
        dst (PathSpec): the destination.
        to_path (str): the destination's Dropbox path.
        op (Callable[[str], Awaitable[T]]): the copy or move to a path.
        undo (Callable[[str, T], Awaitable[Any]]): what takes back an
            entry the op landed at a path, handed the op's reply.
        empty_folder (bool): whether an empty folder there gives way too.

    Returns:
        tuple[T, dict[str, Any] | None]: the op's reply, and the
        destination it replaced when that was looked up.
    """
    cond = await write_condition(dst, "copy")
    rev = None
    live = None
    if cond is not None and condition_version(cond):
        live = live_of(await lookup(tm, to_path))
        rev = await native_condition(dst, cond, live, "copy")
    try:
        return await op(to_path), None
    except DropboxApiError as exc:
        if exc.summary.startswith(MISSING_SOURCE):
            raise enoent(src.virtual) from exc
        if not exc.summary.startswith(TAKEN):
            raise
        if rev is not None and exc.summary.startswith(TAKEN_BY_FOLDER):
            raise await stale(dst) from exc
        existing = await get_metadata(tm, to_path)
        folder = existing.get(".tag") == "folder"
        if folder and not (
            empty_folder and not await list_folder(tm, to_path, limit=1)
        ):
            raise
    content = (
        live.content
        if live is not None
        else token_of(existing.get(CONTENT_HASH))
    )
    aside = aside_name(to_path)
    try:
        moved = await set_aside(
            lambda: _move_aside(tm, dst, to_path, aside, folder, content),
            lambda: move_path(tm, aside, to_path),
        )
        landed = await land_then_retire(
            lambda: op(to_path),
            lambda landed: undo(to_path, landed),
            lambda: _retire(tm, dst, aside, moved, cond),
            lambda: _absent(tm, aside),
            lambda: move_path(tm, aside, to_path),
        )
    except DropboxApiError as err:
        if err.summary.startswith(MISSING_SOURCE):
            raise enoent(src.virtual) from err
        raise (await _retaken(err, cond, dst)) or err
    return landed, existing


async def _absent(tm: DropboxTokenManager, path: str) -> bool:
    """Whether nothing is at ``path`` any more.

    Args:
        tm (DropboxTokenManager): the account's token manager.
        path (str): the Dropbox path.
    """
    return await lookup(tm, path) is None


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
        lambda landed, made: delete_path(tm, landed, token_of(made.get(REV))),
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
