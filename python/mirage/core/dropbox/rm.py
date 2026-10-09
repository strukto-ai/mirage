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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import (
    conditioned,
    evict_after,
    held_versions,
    invalidate_ancestors,
    invalidate_subtree,
    keep_refused,
)
from mirage.core.dropbox.api import delete_path, list_folder, lookup
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.constants import GONE_SUMMARIES, LOST_SUMMARIES
from mirage.core.dropbox.fingerprint import live_of
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.core.dropbox.unlink import delete_resolved
from mirage.errors.fs import enoent, enotempty
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec
from mirage.utils.key_prefix import child_spec

logger = logging.getLogger(__name__)


async def _delete_tree(
    accessor: DropboxAccessor,
    path: PathSpec,
    lost: list[tuple[PathSpec, str | None]],
) -> bool:
    """Delete a folder file by file, each held to the version read or listed.

    A file that changed stays, with the folders above it; a folder goes once
    a listing shows it empty.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the folder's path.
        lost (list[tuple[PathSpec, str | None]]): receives each file that
            changed, with the version it was measured on.

    Returns:
        bool: whether the folder itself was deleted.
    """
    tm = accessor.token_manager
    api_path = dropbox_path_of(accessor, path)
    entries = await list_folder(tm, api_path)
    specs = [child_spec(path, entry["name"]) for entry in entries]
    held = await held_versions(specs)
    emptied = True
    for entry, spec, version in zip(entries, specs, held):
        if entry.get(".tag") == "folder":
            emptied &= await _delete_tree(accessor, spec, lost)
            continue
        live = live_of(entry)
        want = version or (live.content if live else None)
        if live is None or want != live.content:
            lost.append((spec, want))
            emptied = False
            continue
        try:
            await delete_path(
                tm,
                dropbox_path_of(accessor, spec),
                live.native if want else None,
            )
        except DropboxApiError as exc:
            if exc.summary.startswith(GONE_SUMMARIES):
                logger.debug("%s already gone: %s", spec.virtual, exc)
                continue
            if not exc.summary.startswith(LOST_SUMMARIES):
                raise
            lost.append((spec, want))
            emptied = False
    if not emptied:
        return False
    if await list_folder(tm, api_path, limit=1):
        raise enotempty(path)
    await delete_path(tm, api_path)
    return True


async def _remove(
    accessor: DropboxAccessor,
    path: PathSpec,
    entry: dict[str, Any],
    lost: list[tuple[PathSpec, str | None]],
) -> bool:
    """Delete a looked-up entry: a file alone, a folder walked.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the operand.
        entry (dict[str, Any]): the operand's metadata.
        lost (list[tuple[PathSpec, str | None]]): receives each file the
            walk left because it changed.

    Returns:
        bool: True, so the settle step can tell a finished op.
    """
    if entry.get(".tag") == "folder":
        await _delete_tree(accessor, path, lost)
    else:
        await delete_resolved(accessor, path, entry)
    return True


async def rm_r(accessor: DropboxAccessor, path: PathSpec) -> None:
    """Remove a file or folder; a conditional mount walks it file by file.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the operand.
    """
    api_path = dropbox_path_of(accessor, path)
    timer = start_op()
    if not conditioned(path, "delete"):
        try:
            await delete_path(accessor.token_manager, api_path)
        except DropboxApiError as exc:
            if exc.status == 409:
                raise enoent(path.virtual) from exc
            raise
        record("rm_r", path.virtual, "dropbox", 0, timer)
        await invalidate_subtree(path)
        await invalidate_ancestors(path)
        return
    entry = await lookup(accessor.token_manager, api_path)
    if entry is None:
        raise enoent(path.virtual)
    upto = lost_count()
    lost: list[tuple[PathSpec, str | None]] = []

    async def settle(done: bool | None) -> None:
        record("rm_r", path.virtual, "dropbox", 0, timer)
        await invalidate_subtree(path)
        await invalidate_ancestors(path)
        refusal = await keep_refused(lost)
        if done and refusal is not None:
            raise refusal

    await evict_after(_remove(accessor, path, entry, lost), settle)
    lift_lost(path, upto, subtree=True)
