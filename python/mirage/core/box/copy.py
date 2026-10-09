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

from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import (
    evict_after,
    evict_keeping_version,
    invalidate_after_write,
    invalidate_subtree,
    native_condition,
    stale,
    write_condition,
    writes_conditioned,
)
from mirage.cache.types import WriteCondition
from mirage.core.box.api import (
    copy_file,
    copy_folder,
    delete_file,
    list_folder_items,
    refused,
)
from mirage.core.box.client import BoxApiError
from mirage.core.box.constants import CONFLICT_STATUS
from mirage.core.box.fingerprint import live_of
from mirage.core.box.resolve import (
    path_parts,
    resolve_item,
    resolve_parent_id,
)
from mirage.errors.fs import eisdir, enoent, enotdir
from mirage.errors.types import StaleWriteError
from mirage.observe.context import (
    OpTimer,
    lift_lost,
    lost_count,
    record,
    start_op,
)
from mirage.types import PathSpec
from mirage.utils.key_prefix import child_spec


async def replace_file(
    accessor: BoxAccessor, dst: PathSpec, existing: dict[str, Any] | None
) -> WriteCondition | None:
    """Clear the file a copy or move lands on, held to the version read.

    Args:
        accessor (BoxAccessor): Box accessor.
        dst (PathSpec): the destination.
        existing (dict[str, Any] | None): the file there, None when none.

    Returns:
        WriteCondition | None: the op's condition, None when unconditional.
    """
    cond = await write_condition(dst, "copy")
    etag = await native_condition(dst, cond, live_of(existing), "copy")
    if existing is not None:
        try:
            await delete_file(accessor.token_manager, existing["id"], etag)
        except BoxApiError as exc:
            raise (await refused(dst, exc, cond, etag)) or exc
    return cond


async def retaken(
    exc: BoxApiError, cond: WriteCondition | None, dst: PathSpec
) -> StaleWriteError | None:
    """The refusal for a copy or move whose cleared destination came back.

    The held version stays held; a folder or web link there keeps none.

    Args:
        exc (BoxApiError): Box's answer to the copy or move.
        cond (WriteCondition | None): the condition the op carries.
        dst (PathSpec): the destination.
    """
    if cond is None or exc.status != CONFLICT_STATUS:
        return None
    if cond.if_match and exc.conflict in (None, "file"):
        return await stale(dst, version=cond.if_match)
    return await stale(dst, gone=True)


async def _landed(
    changed: list[tuple[PathSpec, bool]],
    dst: PathSpec,
    whole: bool,
    timer: OpTimer,
    upto: int,
) -> None:
    """Record a path the copy changed, as soon as it changed.

    A later step of the same copy can take a while, and another stage of
    the line may read the path meanwhile: recorded now, the retract
    stays older than that read. On a ``write: conditional`` mount the
    path's cached bytes go with the retract, so that read cannot take the
    old bytes without the version that would refuse a write of them.

    Args:
        changed (list[tuple[PathSpec, bool]]): the copy's changed paths.
        dst (PathSpec): the path cleared or landed.
        whole (bool): a folder copied whole.
        timer (OpTimer): the step's timer.
        upto (int): :func:`lost_count` when the step began.
    """
    changed.append((dst, whole))
    record("copy_prefix" if whole else "copy", dst.virtual, "box", 0, timer)
    if whole:
        lift_lost(dst, upto, subtree=True)
    if not writes_conditioned():
        return
    if whole:
        await invalidate_subtree(dst)
    else:
        await invalidate_after_write(dst)


async def _copy_into(
    accessor: BoxAccessor,
    item: dict[str, Any],
    dst: PathSpec,
    changed: list[tuple[PathSpec, bool]],
    sent: list[tuple[PathSpec, bool]],
) -> None:
    """Copy ``item`` to ``dst``, merging a folder into a folder.

    Args:
        accessor (BoxAccessor): Box accessor.
        item (dict[str, Any]): the source as its lookup found it.
        dst (PathSpec): where it lands.
        changed (list[tuple[PathSpec, bool]]): receives each path this
            copy changed (a destination cleared, a file or a whole folder
            landed), recorded as it changed, and whether it is a folder.
        sent (list[tuple[PathSpec, bool]]): receives each path a request
            may have gone out for, landed or not, and whether it is a
            folder.
    """
    tm = accessor.token_manager
    timer = start_op()
    upto = lost_count()
    dst_parts = path_parts(dst)
    existing = await resolve_item(accessor, dst_parts)
    if (
        item.get("type") == "folder"
        and existing is not None
        and existing.get("type") == "folder"
    ):
        # Merge into an existing folder, as cp -r does: copy each child
        # rather than replacing the folder, so pre-existing entries survive.
        for child in await list_folder_items(tm, item["id"]):
            await _copy_into(
                accessor, child, child_spec(dst, child["name"]), changed, sent
            )
        return
    dst_parent = await resolve_parent_id(accessor, dst_parts)
    if dst_parent is None:
        raise enoent(dst.virtual)
    new_name = dst_parts[-1]
    cond: WriteCondition | None = None
    cleared = False
    if existing is not None and existing["id"] != item["id"]:
        # Folder onto folder already merged above, so what is left is a type
        # mismatch or a file replacing a file. cp refuses either mismatch
        # (rename(2)'s own errnos), mirroring gdrive and the msgraph
        # copy_tree; only a file gives way to a file.
        if existing.get("type") == "folder":
            raise eisdir(dst.virtual)
        if item.get("type") == "folder":
            raise enotdir(dst.virtual)
        sent.append((dst, False))
        cond = await replace_file(accessor, dst, existing)
        await _landed(changed, dst, False, timer, upto)
        cleared = True
    elif existing is None and item.get("type") == "file":
        cond = await replace_file(accessor, dst, None)
    try:
        if item.get("type") == "folder":
            sent.append((dst, True))
            await copy_folder(tm, item["id"], dst_parent, name=new_name)
            await _landed(changed, dst, True, timer, upto)
        else:
            sent.append((dst, False))
            await copy_file(tm, item["id"], dst_parent, name=new_name)
            if not cleared:
                await _landed(changed, dst, False, timer, upto)
    except BoxApiError as exc:
        raise (await retaken(exc, cond, dst)) or exc


async def copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec) -> None:
    """Copy a file or folder server-side, recording each path it changed.

    Each path is recorded as it changes, and on a conditional mount
    evicted with its record; a file is evicted again once the copy ends,
    since a clear and the copy that lands after it are two steps. The
    eviction runs also when the copy fails. A conditional mount evicts
    only what changed, and a request that raised keeps its held version. A
    folder copied whole also lifts the line's lost marks beneath it; one
    whose request raised evicts its subtree and records nothing.

    Args:
        accessor (BoxAccessor): Box accessor.
        src (PathSpec): the item to copy.
        dst (PathSpec): where the copy lands.
    """
    item = await resolve_item(accessor, path_parts(src))
    if item is None:
        raise enoent(src.virtual)
    folder = item.get("type") == "folder"
    changed: list[tuple[PathSpec, bool]] = []
    sent: list[tuple[PathSpec, bool]] = []

    async def evict(_: None) -> None:
        if not writes_conditioned():
            if folder:
                await invalidate_subtree(dst)
            else:
                await invalidate_after_write(dst)
            return
        for spec, whole in changed:
            if not whole:
                await invalidate_after_write(spec)
        landed = {spec.virtual for spec, _whole in changed}
        for spec, whole in sent:
            if spec.virtual in landed:
                continue
            if whole:
                await invalidate_subtree(spec)
            else:
                await evict_keeping_version(spec)

    await evict_after(_copy_into(accessor, item, dst, changed, sent), evict)
