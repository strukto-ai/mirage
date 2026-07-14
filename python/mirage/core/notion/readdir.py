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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.notion.pages import (list_block_children, query_database,
                                      search_databases, search_pages)
from mirage.core.notion.pathing import (database_dirname, page_dirname,
                                        split_suffix_id)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.sanitize import sanitize_name

VIRTUAL_ROOTS = ("pages", "databases")


async def readdir(
    accessor: NotionAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    path = (path.dir if path.pattern else path).mount_path
    key = path.strip("/")
    idx_key = "/" + key if key else "/"

    if not key:
        return [f"{prefix}/{root}" for root in VIRTUAL_ROOTS]

    if key == "pages":
        if index is not None:
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return [f"{prefix}{entry}" for entry in listing.entries]
        pages = await search_pages(accessor.config)
        top_level = [
            p for p in pages if p.get("parent", {}).get("type") == "workspace"
        ]
        entries = []
        for page in top_level:
            dirname = page_dirname(page)
            entry = IndexEntry(
                id=page["id"],
                name=dirname,
                resource_type="notion/page",
                remote_time=page.get("last_edited_time", ""),
                vfs_name=dirname,
            )
            entries.append((dirname, entry))
        if index is not None:
            await index.set_dir(idx_key, entries)
        return [f"{prefix}/pages/{name}" for name, _ in entries]

    if key == "databases":
        if index is not None:
            listing = await index.list_dir(idx_key)
            if listing.entries is not None:
                return [f"{prefix}{entry}" for entry in listing.entries]
        databases = await search_databases(accessor.config)
        entries = []
        for database in databases:
            dirname = database_dirname(database)
            entry = IndexEntry(
                id=database["id"],
                name=dirname,
                resource_type="notion/database",
                remote_time=database.get("last_edited_time", ""),
                vfs_name=dirname,
            )
            entries.append((dirname, entry))
        if index is not None:
            await index.set_dir(idx_key, entries)
        return [f"{prefix}/databases/{name}" for name, _ in entries]

    parts = key.split("/")
    if (parts[0] == "pages" and len(parts) >= 2) or (parts[0] == "databases"
                                                     and len(parts) >= 3):
        _, page_id = split_suffix_id(parts[-1])
        page_idx_key = "/" + "/".join(parts)

        if index is not None:
            listing = await index.list_dir(page_idx_key)
            if listing.entries is not None:
                return [f"{prefix}{entry}" for entry in listing.entries]

        blocks = await list_block_children(accessor.config, page_id)
        child_pages = [b for b in blocks if b.get("type") == "child_page"]
        entries: list[tuple[str, IndexEntry]] = []

        page_json_entry = IndexEntry(
            id=f"{page_id}:page",
            name="page.json",
            resource_type="file",
            vfs_name="page.json",
        )
        entries.append(("page.json", page_json_entry))

        for child_block in child_pages:
            child_title = child_block.get("child_page",
                                          {}).get("title", "untitled")
            child_id = child_block["id"]
            dirname = f"{sanitize_name(child_title)}__{child_id}"
            child_entry = IndexEntry(
                id=child_id,
                name=dirname,
                resource_type="notion/page",
                remote_time=child_block.get("last_edited_time", ""),
                vfs_name=dirname,
            )
            entries.append((dirname, child_entry))

        if index is not None:
            await index.set_dir(page_idx_key, entries)

        base = f"{prefix}/{key}"
        return [f"{base}/{name}" for name, _ in entries]

    if len(parts) == 2 and parts[0] == "databases":
        _, database_id = split_suffix_id(parts[1])
        database_idx_key = "/" + "/".join(parts)

        if index is not None:
            listing = await index.list_dir(database_idx_key)
            if listing.entries is not None:
                return [f"{prefix}{entry}" for entry in listing.entries]

        rows = await query_database(accessor.config, database_id)
        entries: list[tuple[str, IndexEntry]] = []
        database_json_entry = IndexEntry(
            id=f"{database_id}:database",
            name="database.json",
            resource_type="file",
            vfs_name="database.json",
        )
        entries.append(("database.json", database_json_entry))
        for row in rows:
            if row.get("object") != "page":
                continue
            dirname = page_dirname(row)
            row_entry = IndexEntry(
                id=row["id"],
                name=dirname,
                resource_type="notion/page",
                remote_time=row.get("last_edited_time", ""),
                vfs_name=dirname,
            )
            entries.append((dirname, row_entry))

        if index is not None:
            await index.set_dir(database_idx_key, entries)

        base = f"{prefix}/{key}"
        return [f"{base}/{name}" for name, _ in entries]

    return []
