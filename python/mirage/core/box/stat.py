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

from mirage.accessor.box import BoxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.box.api import absent_on_404, get_folder_info
from mirage.core.box.readdir import resource_type_for, stat_from_item
from mirage.core.box.resolve import item_of, live_item, root_id
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def stat(
    accessor: BoxAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """What is at ``path``: the row its parent's listing named.

    The mount root has no parent listing to inherit an mtime from, so
    the folder's own metadata is fetched; ``find -mtime`` and ``ls -ld``
    then see a real timestamp. A fresh check is answered live: by the
    one request the mount's row leads to, else by walking the listings.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the path.
        entry (FileStat | None): what is at the path.
        index (IndexCacheStore): the store the stat runs under; a fresh
            check's offers the mount's rows as leads.
    """
    virtual = path.virtual
    key = path.vfs_path
    if not key.strip("/"):
        folder_id = root_id(accessor)
        info = await absent_on_404(
            virtual, lambda: get_folder_info(accessor.token_manager, folder_id)
        )
        return FileStat(
            name="/",
            type=FileType.DIRECTORY,
            modified=info.get("modified_at") or "",
            extra={"box_id": folder_id},
        )
    if isinstance(index, ListingCheckStore):
        prefix = mount_prefix_of(path.virtual, path.vfs_path)
        virtual_key = prefix + "/" + key.strip("/")
        # The check's store offers the mount's row as a lead, never an
        # answer: its id leads to one live request.
        hint = await index.hint(virtual_key)
        lead = item_of(hint) if isinstance(hint, FileStat) else None
        item = await absent_on_404(
            virtual, lambda: live_item(accessor, path, lead)
        )
        if item is None or resource_type_for(item) == "box/weblink":
            # Weblinks are hidden from listings; a direct lookup must
            # not resurface a sizeless, unreadable entry.
            raise enoent(virtual)
        row = stat_from_item(item)
        # The check's store keeps what it found: a check that proves the
        # copy fresh retains it as the row the next check leads with.
        await index.put(virtual_key, row)
        return row
    if entry is None:
        raise enoent(virtual)
    return entry
