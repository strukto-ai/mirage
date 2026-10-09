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
from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import (
    conditioned,
    evict_after,
    held_versions,
    invalidate_after_unlink,
    invalidate_subtree,
    keep_refused,
)
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.box.api import (
    delete_file,
    delete_folder,
    delete_web_link,
    list_folder_items,
)
from mirage.core.box.client import BoxApiError, BoxTokenManager
from mirage.core.box.constants import CONFLICT_STATUS, GONE_STATUS, LOST_STATUS
from mirage.core.box.fingerprint import live_of
from mirage.core.box.resolve import path_parts, resolve_item
from mirage.core.box.unlink import delete_resolved
from mirage.errors.fs import enoent, enotdir, enotempty
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec
from mirage.utils.key_prefix import child_spec

logger = logging.getLogger(__name__)


async def rmdir(
    accessor: BoxAccessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> None:
    parts = path_parts(path)
    item = await resolve_item(accessor, parts)
    if item is None:
        raise enoent(path.virtual)
    if item.get("type") != "folder":
        raise enotdir(path.virtual)
    await delete_empty_folder(accessor.token_manager, item["id"], path)
    await invalidate_after_unlink(path)


async def delete_empty_folder(
    tm: BoxTokenManager, folder_id: str, path: PathSpec
) -> None:
    """Delete a folder only if it is empty: Box's 409 becomes ENOTEMPTY.

    Args:
        tm (BoxTokenManager): token manager.
        folder_id (str): the folder's id.
        path (PathSpec): the folder's path, for the error.

    Raises:
        OSError: ENOTEMPTY when the folder still holds anything.
    """
    try:
        await delete_folder(tm, folder_id, recursive=False)
    except BoxApiError as exc:
        if exc.status == CONFLICT_STATUS:
            raise enotempty(path) from exc
        raise


async def _delete_link(
    tm: BoxTokenManager, link_id: str, path: PathSpec
) -> None:
    """Delete a web link plainly, since it holds no content.

    Args:
        tm (BoxTokenManager): token manager.
        link_id (str): the web link's id.
        path (PathSpec): the web link's path, for the log.
    """
    try:
        await delete_web_link(tm, link_id)
    except BoxApiError as exc:
        if exc.status != GONE_STATUS:
            raise
        logger.debug("%s already gone: %s", path.virtual, exc)


async def _delete_tree(
    accessor: BoxAccessor,
    folder: dict[str, Any],
    path: PathSpec,
    lost: list[tuple[PathSpec, str | None]],
) -> bool:
    """Delete a folder file by file, each held to the version read or listed.

    A file that changed stays, with the folders above it.

    Args:
        accessor (BoxAccessor): Box accessor.
        folder (dict[str, Any]): the folder as its lookup found it.
        path (PathSpec): the folder's path.
        lost (list[tuple[PathSpec, str | None]]): receives each file that
            changed, with the version it was measured on.

    Returns:
        bool: whether the folder itself was deleted.
    """
    tm = accessor.token_manager
    kids = await list_folder_items(tm, folder["id"])
    specs = [child_spec(path, kid["name"]) for kid in kids]
    held = await held_versions(specs)
    emptied = True
    for kid, spec, version in zip(kids, specs, held):
        if kid.get("type") == "folder":
            emptied &= await _delete_tree(accessor, kid, spec, lost)
            continue
        if kid.get("type") == "web_link":
            await _delete_link(tm, kid["id"], spec)
            continue
        live = live_of(kid)
        want = version or (live.content if live else None)
        if live is None or want != live.content:
            lost.append((spec, want))
            emptied = False
            continue
        try:
            await delete_file(tm, kid["id"], live.native if want else None)
        except BoxApiError as exc:
            if exc.status == GONE_STATUS:
                logger.debug("%s already gone: %s", spec.virtual, exc)
                continue
            if exc.status != LOST_STATUS:
                raise
            lost.append((spec, want))
            emptied = False
    if not emptied:
        return False
    await delete_empty_folder(tm, folder["id"], path)
    return True


async def _remove(
    accessor: BoxAccessor,
    path: PathSpec,
    item: dict[str, Any],
    lost: list[tuple[PathSpec, str | None]],
) -> bool:
    """Delete ``item``: a file alone, a folder walked or whole.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the operand.
        item (dict[str, Any]): the operand as its lookup found it.
        lost (list[tuple[PathSpec, str | None]]): receives each file a
            walk left because it changed.

    Returns:
        bool: True, so the settle step can tell a finished op.
    """
    if item.get("type") != "folder":
        await delete_resolved(accessor, path, item)
    elif conditioned(path, "delete"):
        await _delete_tree(accessor, item, path, lost)
    else:
        await delete_folder(accessor.token_manager, item["id"], recursive=True)
    return True


async def rm_r(accessor: BoxAccessor, path: PathSpec) -> None:
    """Remove a file or folder; a conditional mount walks it file by file.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the operand.
    """
    parts = path_parts(path)
    if not parts:
        return
    item = await resolve_item(accessor, parts)
    if item is None:
        raise enoent(path.virtual)
    upto = lost_count()
    timer = start_op()
    lost: list[tuple[PathSpec, str | None]] = []

    async def settle(done: bool | None) -> None:
        record("rm_r", path.virtual, "box", 0, timer)
        await invalidate_subtree(path)
        refusal = await keep_refused(lost)
        if done and refusal is not None:
            raise refusal

    await evict_after(_remove(accessor, path, item, lost), settle)
    lift_lost(path, upto, subtree=True)
