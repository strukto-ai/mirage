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
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import (
    condition_version,
    native_condition,
    stale,
    write_condition,
)
from mirage.cache.types import WriteCondition
from mirage.core.api.replace import aside_name, land_then_retire, set_aside
from mirage.core.box.api import (
    absent_on_404,
    copy_file,
    copy_folder,
    delete_file,
    get_file_info,
    get_folder_info,
    list_folder_items,
    refused,
    update_file,
    update_folder,
)
from mirage.core.box.client import BoxApiError, BoxTokenManager
from mirage.core.box.constants import CONFLICT_STATUS, GONE_STATUS
from mirage.core.box.fingerprint import live_of
from mirage.core.box.readdir import stat_from_item
from mirage.core.box.resolve import (
    item_of,
    live_item,
    live_item_of,
    parent_folder,
    path_parts,
)
from mirage.core.box.rmdir import delete_empty_folder
from mirage.errors.fs import eisdir, enoent, enotdir
from mirage.errors.types import StaleWriteError
from mirage.observe.context import (
    OpTimer,
    lift_lost,
    lost_count,
    record,
    start_op,
)
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import child_spec
from mirage.utils.upload import upload_stat

logger = logging.getLogger(__name__)


async def held_file(
    accessor: BoxAccessor, dst: PathSpec, existing: Mapping[str, Any] | None
) -> tuple[WriteCondition | None, Mapping[str, Any] | None, str | None]:
    """What a copy or move onto ``dst`` is held to, refusing a stale one.

    Args:
        accessor (BoxAccessor): Box accessor.
        dst (PathSpec): the destination.
        existing (dict[str, Any] | None): the file there, None when none.

    Returns:
        tuple[WriteCondition | None, dict[str, Any] | None, str | None]:
            the op's condition (None when unconditional), the file there
            as the condition saw it, and the etag its delete carries.
    """
    cond = await write_condition(dst, "copy")
    if cond is not None:
        existing = await live_item(accessor, dst, existing)
    etag = await native_condition(dst, cond, live_of(existing), "copy")
    return cond, existing, etag


async def clear_file(
    accessor: BoxAccessor,
    dst: PathSpec,
    existing: Mapping[str, Any],
    cond: WriteCondition | None,
    etag: str | None,
) -> None:
    """Delete the file a copy or move replaces, held to ``etag``.

    Args:
        accessor (BoxAccessor): Box accessor.
        dst (PathSpec): the destination.
        existing (dict[str, Any]): the file there.
        cond (WriteCondition | None): the op's condition.
        etag (str | None): the etag the delete carries.
    """
    try:
        await delete_file(accessor.token_manager, existing["id"], etag)
    except BoxApiError as exc:
        raise (await refused(dst, exc, cond, etag)) or exc


async def replace_file(
    accessor: BoxAccessor, dst: PathSpec, existing: Mapping[str, Any] | None
) -> WriteCondition | None:
    """Clear the file a copy or move lands on, held to the version read.

    Args:
        accessor (BoxAccessor): Box accessor.
        dst (PathSpec): the destination.
        existing (dict[str, Any] | None): the file there, None when none.

    Returns:
        WriteCondition | None: the op's condition, None when unconditional.
    """
    cond, existing, etag = await held_file(accessor, dst, existing)
    if existing is not None:
        await clear_file(accessor, dst, existing, cond, etag)
    return cond


async def retaken(
    exc: BoxApiError, cond: WriteCondition | None, dst: PathSpec
) -> StaleWriteError | None:
    """The refusal for a copy or move whose cleared destination came back.

    The condition the op sent stays held, whatever took the name.

    Args:
        exc (BoxApiError): Box's answer to the copy or move.
        cond (WriteCondition | None): the condition the op carries.
        dst (PathSpec): the destination.
    """
    if cond is None or exc.status != CONFLICT_STATUS:
        return None
    return await stale(dst, version=condition_version(cond))


async def _landed(
    dst: PathSpec,
    whole: bool,
    timer: OpTimer,
    upto: int,
) -> None:
    """Record a path the copy changed, as soon as it changed.

    A later step of the same copy can take a while, and another stage of
    the line may read the path meanwhile: recorded now, the retract
    stays older than that read, and the dispatcher serves no cached
    bytes for a path the line retracted.

    Args:
        dst (PathSpec): the path landed.
        whole (bool): a folder copied whole.
        timer (OpTimer): the step's timer.
        upto (int): :func:`lost_count` when the step began.
    """
    record("copy_prefix" if whole else "copy", dst.virtual, "box", 0, timer)
    lift_lost(dst, upto, subtree=whole)


async def place(
    tm: BoxTokenManager,
    item: Mapping[str, Any],
    name: str,
    folder_id: str | None,
    etag: str | None = None,
) -> dict[str, Any]:
    """Give ``item`` a name, and a folder unless ``folder_id`` is None.

    Args:
        tm (BoxTokenManager): token manager.
        item (dict[str, Any]): the file or folder.
        name (str): its new name.
        folder_id (str | None): the folder it moves into.
        etag (str | None): the version the move is held to, None to go
            plain.
    """
    if item.get("type") == "folder":
        return await update_folder(
            tm, item["id"], name=name, parent_id=folder_id, etag=etag
        )
    return await update_file(
        tm, item["id"], name=name, parent_id=folder_id, etag=etag
    )


async def gone(tm: BoxTokenManager, item: Mapping[str, Any]) -> bool:
    """Whether a file or folder is gone from Box, or sits in its trash.

    Args:
        tm (BoxTokenManager): token manager.
        item (dict[str, Any]): the item.
    """
    info: Mapping[str, Any]
    try:
        if item.get("type") == "folder":
            info = await get_folder_info(tm, item["id"])
        else:
            info = await get_file_info(tm, item["id"])
    except BoxApiError as exc:
        if exc.status == GONE_STATUS:
            return True
        raise
    return info.get("item_status") == "trashed"


async def replace_item(
    accessor: BoxAccessor,
    dst: PathSpec,
    existing: Mapping[str, Any],
    cond: WriteCondition | None,
    etag: str | None,
    land: Callable[[], Awaitable[dict[str, Any]]],
    take_back: Callable[[dict[str, Any]], Awaitable[Any]],
    arrived: Callable[[], Awaitable[dict[str, Any] | None]],
) -> dict[str, Any]:
    """Land an item on the name ``existing`` holds, replacing it.

    Box refuses a taken name, so ``existing`` moves aside under a staged
    name first, a file held to ``etag``, then the item lands on the name,
    and what moved aside is deleted last: a file held to the version its
    move answered, a folder only while it is empty. A refused or lost
    step puts both back, and a landing whose answer was lost but which
    went through is finished (``land_then_retire``).

    Args:
        accessor (BoxAccessor): Box accessor.
        dst (PathSpec): the destination.
        existing (dict[str, Any]): what holds its name.
        cond (WriteCondition | None): the op's condition.
        etag (str | None): the version ``existing`` is held to.
        land (Callable[[], Awaitable[dict[str, Any]]]): the copy or move
            onto the name.
        take_back (Callable[[dict[str, Any]], Awaitable[Any]]): what
            undoes a landing, held to the version it landed as.
        arrived (Callable[[], Awaitable[dict[str, Any] | None]]): what
            the landing made, when it went through.

    Returns:
        dict[str, Any]: what the landing answered.
    """
    tm = accessor.token_manager
    name = path_parts(dst)[-1]
    try:
        moved = await set_aside(
            lambda: place(tm, existing, aside_name(name), None, etag),
            lambda: place(tm, existing, name, None),
        )
    except BoxApiError as exc:
        raise (await refused(dst, exc, cond, etag)) or exc

    async def retire() -> None:
        if existing.get("type") == "folder":
            await delete_empty_folder(tm, existing["id"], dst)
        else:
            await clear_file(accessor, dst, moved, cond, moved.get("etag"))

    try:
        return await land_then_retire(
            land,
            take_back,
            retire,
            lambda: gone(tm, existing),
            lambda: place(tm, existing, name, None),
            arrived,
        )
    except BoxApiError as exc:
        raise (await retaken(exc, cond, dst)) or exc


async def _copied_as(
    tm: BoxTokenManager,
    item: Mapping[str, Any],
    folder_id: str,
    name: str,
) -> dict[str, Any] | None:
    """The copy of ``item`` a copy onto ``name`` landed: a file of that
    name in ``folder_id`` with ``item``'s sha1, None when there is none,
    or no sha1 to tell it by.

    Args:
        tm (BoxTokenManager): token manager.
        item (dict[str, Any]): the file copied.
        folder_id (str): the folder the copy lands in.
        name (str): the name it lands on.
    """
    sha1 = item.get("sha1")
    if not sha1:
        return None
    for entry in await list_folder_items(tm, folder_id):
        if (
            entry.get("type") == "file"
            and entry.get("name") == name
            and entry.get("sha1") == sha1
        ):
            return dict(entry)
    return None


async def _copy_over(
    accessor: BoxAccessor,
    item: Mapping[str, Any],
    dst: PathSpec,
    folder_id: str,
    existing: Mapping[str, Any],
) -> dict[str, Any]:
    """Copy a file onto the file that holds ``dst``'s name.

    A stale destination is refused before anything is sent; the rest is
    ``replace_item``, whose undo for a landed copy is its delete, held to
    the version it landed as, so a write onto it since is kept. A copy
    whose answer was lost is found by its sha1 (``_copied_as``).

    Args:
        accessor (BoxAccessor): Box accessor.
        item (dict[str, Any]): the file copied.
        dst (PathSpec): where the copy lands.
        folder_id (str): the folder ``dst`` is in.
        existing (dict[str, Any]): the file at ``dst``.
    """
    tm = accessor.token_manager
    new_name = path_parts(dst)[-1]
    cond, live, etag = await held_file(accessor, dst, existing)
    if live is None:
        try:
            return await copy_file(tm, item["id"], folder_id, name=new_name)
        except BoxApiError as exc:
            raise (await retaken(exc, cond, dst)) or exc
    return await replace_item(
        accessor,
        dst,
        live,
        cond,
        etag,
        lambda: copy_file(tm, item["id"], folder_id, name=new_name),
        lambda made: delete_file(tm, made["id"], made.get("etag")),
        lambda: _copied_as(tm, item, folder_id, new_name),
    )


async def _copy_into(
    accessor: BoxAccessor,
    item: Mapping[str, Any],
    dst: PathSpec,
    folder_id: str,
    existing: Mapping[str, Any] | None,
) -> FileStat | None:
    """Copy ``item`` to ``dst``, merging a folder into a folder.

    Args:
        accessor (BoxAccessor): Box accessor.
        item (dict[str, Any]): the source as its lookup found it.
        dst (PathSpec): where it lands.
        folder_id (str): the folder ``dst`` lands in.
        existing (dict[str, Any] | None): what is at ``dst``.

    Returns:
        FileStat | None: the copy's stat, None for a merge or a reply
            that names none.
    """
    tm = accessor.token_manager
    timer = start_op()
    upto = lost_count()
    if (
        item.get("type") == "folder"
        and existing is not None
        and existing.get("type") == "folder"
    ):
        # Merge into an existing folder, as cp -r does: copy each child
        # rather than replacing the folder, so pre-existing entries survive.
        # A folder the listing named but Box no longer has is ENOENT, which
        # has the mount list again and copy into what is there now.
        there = {
            kid["name"]: kid
            for kid in await absent_on_404(
                dst.virtual, lambda: list_folder_items(tm, existing["id"])
            )
        }
        kids = await absent_on_404(
            dst.virtual, lambda: list_folder_items(tm, item["id"])
        )
        for child in kids:
            await _copy_into(
                accessor,
                child,
                child_spec(dst, child["name"]),
                existing["id"],
                there.get(child["name"]),
            )
        return None
    new_name = path_parts(dst)[-1]
    if existing is not None and existing["id"] != item["id"]:
        # Folder onto folder already merged above, so what is left is a type
        # mismatch or a file replacing a file. cp refuses either mismatch
        # (rename(2)'s own errnos), mirroring gdrive and the msgraph
        # copy_tree; only a file gives way to a file.
        if existing.get("type") == "folder":
            raise eisdir(dst.virtual)
        if item.get("type") == "folder":
            raise enotdir(dst.virtual)
        made = await _copy_over(accessor, item, dst, folder_id, existing)
        await _landed(dst, False, timer, upto)
        return upload_stat(made, stat_from_item, dst.virtual)
    cond: WriteCondition | None = None
    if existing is None and item.get("type") == "file":
        cond = await replace_file(accessor, dst, None)
    try:
        if item.get("type") == "folder":
            made = await copy_folder(tm, item["id"], folder_id, name=new_name)
            await _landed(dst, True, timer, upto)
        else:
            made = await copy_file(tm, item["id"], folder_id, name=new_name)
            await _landed(dst, False, timer, upto)
    except BoxApiError as exc:
        raise (await retaken(exc, cond, dst)) or exc
    return upload_stat(made, stat_from_item, dst.virtual)


async def copy(
    accessor: BoxAccessor,
    src: PathSpec,
    dst: PathSpec,
    entry: FileStat | None = None,
    dst_parent: FileStat | None = None,
    dst_entry: FileStat | None = None,
) -> FileStat | None:
    """Copy a file or folder server-side, recording each path it changed.

    Each path is recorded as it lands; a replaced file only once its copy
    lands, so through the clear the line keeps its version. A landed path
    also lifts the line's lost marks on it, and beneath it for a folder
    copied whole. The dispatcher evicts what the copy changed, also when
    it fails.

    Args:
        accessor (BoxAccessor): Box accessor.
        src (PathSpec): the item to copy.
        dst (PathSpec): where the copy lands.
        entry (FileStat | None): what is at ``src``.
        dst_parent (FileStat | None): what is at ``dst``'s parent path.
        dst_entry (FileStat | None): what is at ``dst``.

    Returns:
        FileStat | None: the copy's stat, None for a merge or a reply
            that names none.
    """
    item = item_of(entry)
    if item is None:
        raise enoent(src.virtual)
    return await _copy_into(
        accessor,
        item,
        dst,
        parent_folder(accessor, dst, dst_parent),
        await live_item_of(accessor, dst, dst_entry),
    )
