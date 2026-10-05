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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import invalidate_after_move, invalidate_ancestors
from mirage.core.dropbox.api import (
    delete_path,
    get_metadata,
    list_folder,
    move_path,
)
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def rename(
    accessor: DropboxAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """move_v2 rejects an existing destination, but rename(2) replaces
    one: a file outright, and a directory when it is empty. So a
    conflict deletes the target and retries, except for a folder that
    still lists a child, where the original error propagates and the
    generic mv reports GNU's "Directory not empty" (mirrors msgraph's
    rename_replace).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        src (PathSpec): source path.
        dst (PathSpec): destination path.
    """
    from_path = dropbox_path_of(accessor, src)
    to_path = dropbox_path_of(accessor, dst)
    timer = start_op()
    replaced_non_file = False
    try:
        moved = await move_path(accessor.token_manager, from_path, to_path)
    except DropboxApiError as exc:
        if exc.summary.startswith("from_lookup/not_found"):
            raise enoent(src.virtual) from exc
        if not exc.summary.startswith("to/conflict"):
            raise
        existing = await get_metadata(accessor.token_manager, to_path)
        if existing.get(".tag") == "folder":
            children = await list_folder(
                accessor.token_manager, to_path, limit=1
            )
            if children:
                raise
        await delete_path(accessor.token_manager, to_path)
        replaced_non_file = existing.get(".tag") != "file"
        moved = await move_path(accessor.token_manager, from_path, to_path)
    record("rename", src.virtual, "dropbox", 0, timer)
    # A folder carries a subtree under both names. dst also loses one when
    # the move replaced anything there but a file (an empty folder, or an
    # entry of no known kind), whose name may still have cached children.
    # Only a file tag narrows; a reply that names no type keeps the
    # subtree.
    folder = moved.get(".tag") != "file"
    await invalidate_after_move(src, folder)
    await invalidate_ancestors(src)
    await invalidate_after_move(dst, folder or replaced_non_file)
    await invalidate_ancestors(dst)
