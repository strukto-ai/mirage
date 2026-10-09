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
    invalidate_after_write,
    invalidate_subtree,
    native_condition,
    stale,
    write_condition,
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
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.key_prefix import child_spec


async def replace_file(
    accessor: BoxAccessor, dst: PathSpec, existing: dict[str, Any] | None
) -> WriteCondition | None:
    """Clear the file a copy or move lands on, conditioned when it must be.

    On a ``write: conditional`` mount the delete carries the destination's
    etag when mirage holds its version, so a destination changed since it
    was read is refused, not destroyed.

    Args:
        accessor (BoxAccessor): Box accessor.
        dst (PathSpec): the destination.
        existing (dict[str, Any] | None): the file there, None when none.

    Returns:
        WriteCondition | None: the condition the op carries, None on an
        unconditional mount; a destination that comes back before the copy
        lands is then another writer's.

    Raises:
        StaleWriteError: the destination changed or went since it was read.
    """
    cond = await write_condition(dst, "copy")
    etag = await native_condition(dst, cond, live_of(existing), "copy")
    if existing is not None:
        try:
            await delete_file(accessor.token_manager, existing["id"], etag)
        except BoxApiError as exc:
            lost = await refused(dst, exc, cond, etag)
            if lost is not None:
                raise lost from exc
            raise
    return cond


async def retaken(
    exc: BoxApiError, cond: WriteCondition | None, dst: PathSpec
) -> StaleWriteError | None:
    """The refusal for a copy or move whose cleared destination came back.

    Another writer took the name between the clear and the copy. Its file is
    not deleted a second time, and the version held stays held, so a retry
    without a read is refused again; a folder or web link there holds no
    file version, so it keeps none. None for any other failure.

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


async def _copy_into(
    accessor: BoxAccessor, item: dict[str, Any], dst: PathSpec
) -> None:
    tm = accessor.token_manager
    dst_parts = path_parts(dst)
    existing = await resolve_item(accessor, dst_parts)
    if (
        item.get("type") == "folder"
        and existing is not None
        and existing.get("type") == "folder"
    ):
        # Merge into an existing folder (GNU cp -r semantics): copy each child
        # rather than replacing the folder, so pre-existing entries survive.
        for child in await list_folder_items(tm, item["id"]):
            spec = child_spec(dst, child["name"])
            timer = start_op()
            await _copy_into(accessor, child, spec)
            if child.get("type") == "file":
                record("copy", spec.virtual, "box", 0, timer)
        return
    dst_parent = await resolve_parent_id(accessor, dst_parts)
    if dst_parent is None:
        raise enoent(dst.virtual)
    new_name = dst_parts[-1]
    cond: WriteCondition | None = None
    if existing is not None and existing["id"] != item["id"]:
        # Folder onto folder already merged above, so what is left is a type
        # mismatch or a file replacing a file. cp refuses either mismatch
        # (rename(2)'s own errnos), mirroring gdrive and the msgraph
        # copy_tree; only a file gives way to a file.
        if existing.get("type") == "folder":
            raise eisdir(dst.virtual)
        if item.get("type") == "folder":
            raise enotdir(dst.virtual)
        cond = await replace_file(accessor, dst, existing)
    elif existing is None and item.get("type") == "file":
        cond = await replace_file(accessor, dst, None)
    try:
        if item.get("type") == "folder":
            await copy_folder(tm, item["id"], dst_parent, name=new_name)
        else:
            await copy_file(tm, item["id"], dst_parent, name=new_name)
    except BoxApiError as exc:
        lost = await retaken(exc, cond, dst)
        if lost is not None:
            raise lost from exc
        raise


async def copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec) -> None:
    """Copy a file or folder server-side.

    A folder copy evicts the whole destination subtree: a merge into an
    existing folder replaces children below ``dst`` whose bytes were
    cached under their own keys. A file copy evicts just its target: a
    file has nothing below it, so it skips the subtree walk, which asks
    every store (a keyspace scan on Redis). The eviction runs also when
    the copy fails, since a merge may have landed some children before
    one failed.

    Args:
        accessor (BoxAccessor): Box accessor.
        src (PathSpec): the item to copy.
        dst (PathSpec): where the copy lands.
    """
    item = await resolve_item(accessor, path_parts(src))
    if item is None:
        raise enoent(src.virtual)
    folder = item.get("type") == "folder"
    timer = start_op()

    async def evict(_: None) -> None:
        record("copy", dst.virtual, "box", 0, timer)
        if folder:
            await invalidate_subtree(dst)
        else:
            await invalidate_after_write(dst)

    await evict_after(_copy_into(accessor, item, dst), evict)
