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
    evict_keeping_version,
    held_versions,
    invalidate_after_unlink,
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
from mirage.observe.context import (
    OpTimer,
    lift_lost,
    lost_count,
    record,
    start_op,
)
from mirage.types import PathSpec
from mirage.utils.key_prefix import child_spec, outermost

logger = logging.getLogger(__name__)


async def _removed(path: PathSpec, op: str, upto: int, timer: OpTimer) -> None:
    """Record a path the walk removed, the moment its delete landed.

    Recorded now, the retract stays older than a read another stage of
    the line makes of a file recreated there while the walk goes on.

    Args:
        path (PathSpec): the file or folder removed.
        op (str): ``unlink`` for a file, ``rm_r`` for a folder.
        upto (int): :func:`lost_count` when its delete began.
        timer (OpTimer): its delete's timer.
    """
    record(op, path.virtual, "dropbox", 0, timer)
    lift_lost(path, upto, subtree=op == "rm_r")
    await invalidate_after_unlink(path)


async def _delete_tree(
    accessor: DropboxAccessor,
    path: PathSpec,
    lost: list[tuple[PathSpec, str | None]],
    swept: list[PathSpec],
) -> bool:
    """Delete a folder file by file, each held to the version read or listed.

    A file that changed stays, with the folders above it; a folder goes once
    a listing shows it empty. Each file and folder is recorded as its delete
    lands.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the folder's path.
        lost (list[tuple[PathSpec, str | None]]): receives each file that
            changed, with the version it was measured on.
        swept (list[PathSpec]): receives each folder a delete went out
            for, landed or not, for one subtree eviction when the walk
            ends.

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
            emptied &= await _delete_tree(accessor, spec, lost, swept)
            continue
        live = live_of(entry)
        want = version or (live.content if live else None)
        if live is None or want != live.content:
            lost.append((spec, want))
            emptied = False
            continue
        upto = lost_count()
        timer = start_op()
        try:
            await delete_path(
                tm,
                dropbox_path_of(accessor, spec),
                live.native if want else None,
            )
        except DropboxApiError as exc:
            if not exc.summary.startswith(GONE_SUMMARIES):
                if not exc.summary.startswith(LOST_SUMMARIES):
                    await evict_keeping_version(spec)
                    raise
                lost.append((spec, want))
                emptied = False
                continue
            logger.debug("%s already gone: %s", spec.virtual, exc)
        except BaseException:
            await evict_keeping_version(spec)
            raise
        await _removed(spec, "unlink", upto, timer)
    if not emptied:
        return False
    if await list_folder(tm, api_path, limit=1):
        raise enotempty(path)
    upto = lost_count()
    timer = start_op()
    swept.append(path)
    await delete_path(tm, api_path)
    await _removed(path, "rm_r", upto, timer)
    return True


async def _remove(
    accessor: DropboxAccessor,
    path: PathSpec,
    entry: dict[str, Any],
    lost: list[tuple[PathSpec, str | None]],
    swept: list[PathSpec],
) -> bool:
    """Delete a looked-up entry: a file alone, a folder walked.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the operand.
        entry (dict[str, Any]): the operand's metadata.
        lost (list[tuple[PathSpec, str | None]]): receives each file the
            walk left because it changed.
        swept (list[PathSpec]): receives each folder the walk sent a
            delete for.

    Returns:
        bool: True, so the settle step can tell a finished op.
    """
    if entry.get(".tag") == "folder":
        await _delete_tree(accessor, path, lost, swept)
    else:
        await delete_resolved(accessor, path, entry)
    return True


async def rm_r(accessor: DropboxAccessor, path: PathSpec) -> None:
    """Remove a file or folder; a conditional mount walks it file by file.

    A walk records each file and folder (the operand among them) as its
    delete lands, never the operand's subtree up front or at the end, so
    a file it never reached keeps its version, and a read another stage
    makes after a removal outranks it.
    Anything else is recorded once, for the operand's whole subtree.

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
    walked = entry.get(".tag") == "folder"
    lost: list[tuple[PathSpec, str | None]] = []
    swept: list[PathSpec] = []

    async def settle(done: bool | None) -> None:
        if not walked:
            record("rm_r", path.virtual, "dropbox", 0, timer)
            await invalidate_subtree(path)
        for folder in outermost(swept):
            await invalidate_subtree(folder)
        await invalidate_ancestors(path)
        refusal = await keep_refused(lost)
        if done and refusal is not None:
            raise refusal

    await evict_after(_remove(accessor, path, entry, lost, swept), settle)
    if not walked:
        lift_lost(path, upto, subtree=True)
