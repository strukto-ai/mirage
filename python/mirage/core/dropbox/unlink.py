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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import (
    delete_condition,
    invalidate_after_unlink,
    invalidate_ancestors,
    native_condition,
)
from mirage.core.dropbox.api import delete_path, get_metadata, refused
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.fingerprint import live_of
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec


async def delete_resolved(
    accessor: DropboxAccessor, path: PathSpec, entry: dict[str, Any]
) -> None:
    """Delete a looked-up file, conditioned on a ``write: conditional`` mount.

    A delete needs no read of its own, only that nobody wrote since: the
    version the mount holds, else the content_hash its own lookup found,
    is held against the live one, and the rev goes out as ``parent_rev``.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the file's path.
        entry (dict[str, Any]): the file's metadata, from its lookup.

    Raises:
        StaleWriteError: the file changed or went since it was measured.
    """
    live = live_of(entry)
    cond = await delete_condition(path, live.content if live else None)
    rev = await native_condition(path, cond, live, "delete")
    try:
        await delete_path(
            accessor.token_manager, dropbox_path_of(accessor, path), rev
        )
    except DropboxApiError as exc:
        lost = await refused(path, exc, cond, rev)
        if lost is not None:
            raise lost from exc
        raise


async def unlink(accessor: DropboxAccessor, path: PathSpec) -> None:
    api_path = dropbox_path_of(accessor, path)
    try:
        entry = await get_metadata(accessor.token_manager, api_path)
    except DropboxApiError as exc:
        if exc.status == 409:
            raise enoent(path.virtual) from exc
        raise
    if entry.get(".tag") == "folder":
        raise eisdir(path.virtual)
    timer = start_op()
    upto = lost_count()
    await delete_resolved(accessor, path, entry)
    record("unlink", path.virtual, "dropbox", 0, timer)
    await invalidate_after_unlink(path)
    await invalidate_ancestors(path)
    lift_lost(path, upto)
