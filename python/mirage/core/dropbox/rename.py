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
from mirage.core.dropbox.api import move_path
from mirage.core.dropbox.copy import replace_onto
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec


async def rename(
    accessor: DropboxAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """move_v2 rejects an existing destination, but rename(2) replaces
    one: a file outright, and a directory when it is empty. So a
    conflict deletes the target and retries, except for a folder that
    still lists a child, where the original error propagates and the
    generic mv reports "Directory not empty" (mirrors msgraph's
    rename_replace). The source moves whole, so only a destination it
    replaces is held to its version (``replace_onto``).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        src (PathSpec): source path.
        dst (PathSpec): destination path.
    """
    from_path = dropbox_path_of(accessor, src)
    to_path = dropbox_path_of(accessor, dst)
    tm = accessor.token_manager
    timer = start_op()
    upto = lost_count()

    moved, replaced = await replace_onto(
        tm,
        src,
        dst,
        to_path,
        lambda: move_path(tm, from_path, to_path),
        empty_folder=True,
    )
    replaced_non_file = replaced is not None and replaced.get(".tag") != "file"
    # A folder carries a subtree under both names. dst also loses one when
    # the move replaced anything there but a file (an empty folder, or an
    # entry of no known kind), whose name may still have cached children.
    # Only a file tag narrows; a reply that names no type keeps the
    # subtree.
    folder = moved.get(".tag") != "file"
    op = "rename_prefix" if folder else "rename"
    record(op, src.virtual, "dropbox", 0, timer)
    record(op, dst.virtual, "dropbox", 0, timer)
    await invalidate_after_move(src, folder)
    await invalidate_ancestors(src)
    await invalidate_after_move(dst, folder or replaced_non_file)
    await invalidate_ancestors(dst)
    lift_lost(src, upto, subtree=folder)
    lift_lost(dst, upto, subtree=folder)
