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
from mirage.observe.context import OpTimer, record, start_op
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
    accessor: BoxAccessor,
    item: dict[str, Any],
    dst: PathSpec,
    changed: list[tuple[PathSpec, OpTimer, bool]],
    sent: list[PathSpec],
) -> None:
    """Copy ``item`` to ``dst``, merging a folder into a folder.

    Args:
        accessor (BoxAccessor): Box accessor.
        item (dict[str, Any]): the source as its lookup found it.
        dst (PathSpec): where it lands.
        changed (list[tuple[PathSpec, OpTimer, bool]]): receives each path
            this copy changed (a destination cleared, a file landed, a
            folder copy sent), with its step's timer and whether it is a
            folder.
        sent (list[PathSpec]): receives each file path a request may have
            gone out for, landed or not.
    """
    tm = accessor.token_manager
    timer = start_op()
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
        sent.append(dst)
        cond = await replace_file(accessor, dst, existing)
        changed.append((dst, timer, False))
        cleared = True
    elif existing is None and item.get("type") == "file":
        cond = await replace_file(accessor, dst, None)
    try:
        if item.get("type") == "folder":
            changed.append((dst, timer, True))
            await copy_folder(tm, item["id"], dst_parent, name=new_name)
        else:
            sent.append(dst)
            await copy_file(tm, item["id"], dst_parent, name=new_name)
            if not cleared:
                changed.append((dst, timer, False))
    except BoxApiError as exc:
        lost = await retaken(exc, cond, dst)
        if lost is not None:
            raise lost from exc
        raise


async def copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec) -> None:
    """Copy a file or folder server-side.

    The copy records the paths it changed: a file it cleared or landed,
    and a folder it copied whole. The eviction runs also when the copy
    fails, since a merge may have landed some children before one
    failed. On an unconditional mount it evicts ``dst`` (its subtree for
    a folder). On a ``write: conditional`` mount it evicts exactly what
    changed, so a merge leaves the versions of the files it did not
    touch, and a file request that raised, which may or may not have
    landed, loses its cached bytes and listing but keeps the version
    mirage holds, so a change it did make is refused rather than written
    over.

    Args:
        accessor (BoxAccessor): Box accessor.
        src (PathSpec): the item to copy.
        dst (PathSpec): where the copy lands.
    """
    item = await resolve_item(accessor, path_parts(src))
    if item is None:
        raise enoent(src.virtual)
    folder = item.get("type") == "folder"
    changed: list[tuple[PathSpec, OpTimer, bool]] = []
    sent: list[PathSpec] = []

    async def evict(_: None) -> None:
        for spec, timer, _whole in changed:
            record("copy", spec.virtual, "box", 0, timer)
        if not writes_conditioned():
            if folder:
                await invalidate_subtree(dst)
            else:
                await invalidate_after_write(dst)
            return
        for spec, _timer, whole in changed:
            if whole:
                await invalidate_subtree(spec)
            else:
                await invalidate_after_write(spec)
        landed = {spec.virtual for spec, _timer, _whole in changed}
        for spec in sent:
            if spec.virtual not in landed:
                await evict_keeping_version(spec)

    await evict_after(_copy_into(accessor, item, dst, changed, sent), evict)
