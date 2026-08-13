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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.notion.normalize import (normalize_data_source,
                                          normalize_database, to_json_bytes)
from mirage.core.notion.pages import (get_data_source, get_database,
                                      list_block_children, query_data_source,
                                      search_data_sources, search_pages)
from mirage.core.notion.pathing import (data_source_dirname, database_dirname,
                                        page_dirname, split_suffix_id)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.sanitize import sanitize_name

VIRTUAL_ROOTS = ("pages", "databases")


async def readdir(
    accessor: NotionAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")
    idx_key = "/" + key if key else "/"

    if not key:
        return [f"{prefix}/{root}" for root in VIRTUAL_ROOTS]

    if key == "pages":
        listing = await index.list_dir(idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]
        pages = await search_pages(accessor.config)
        top_level = [
            p for p in pages if p.get("parent", {}).get("type") == "workspace"
        ]
        entries: list[tuple[str, IndexEntry]] = []
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
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/pages/{name}" for name, _ in entries]

    if key == "databases":
        listing = await index.list_dir(idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]
        # Search answers with data sources since 2025-09-03, so the set of
        # databases is their distinct parents. Each one still costs a
        # retrieve, because only the database object carries the title and
        # url this directory is named and rendered from.
        seen: list[str] = []
        for data_source in await search_data_sources(accessor.config):
            owner = data_source.get("parent", {}).get("database_id", "")
            if owner and owner not in seen:
                seen.append(owner)
        entries = []
        for database_id in seen:
            database = await get_database(accessor.config, database_id)
            dirname = database_dirname(database)
            entry = IndexEntry(
                id=database_id,
                name=dirname,
                resource_type="notion/database",
                remote_time=database.get("last_edited_time", ""),
                vfs_name=dirname,
                extra={
                    "database_json_size":
                    len(to_json_bytes(normalize_database(database))),
                },
            )
            entries.append((dirname, entry))
        await index.set_dir(idx_key, entries)
        return [f"{prefix}/databases/{name}" for name, _ in entries]

    # A row page sits two levels below its database (database, then data
    # source), so a page directory under `databases/` starts at depth 4.
    parts = key.split("/")
    if (parts[0] == "pages" and len(parts) >= 2) or (parts[0] == "databases"
                                                     and len(parts) >= 4):
        _, page_id = split_suffix_id(parts[-1])
        page_idx_key = "/" + "/".join(parts)

        listing = await index.list_dir(page_idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]

        blocks = await list_block_children(accessor.config, page_id)
        child_pages = [b for b in blocks if b.get("type") == "child_page"]
        entries = []

        # database.json's size is stashed by the parent listing, but
        # page.json renders from get_page plus the *recursive* block
        # tree while this listing only holds one level of children, so
        # sizing it here would cost an extra call pair per page. It
        # stays size-unknown until a read hydrates it.
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

        await index.set_dir(page_idx_key, entries)

        base = f"{prefix}/{key}"
        return [f"{base}/{name}" for name, _ in entries]

    if len(parts) == 2 and parts[0] == "databases":
        _, database_id = split_suffix_id(parts[1])
        database_idx_key = "/" + "/".join(parts)

        listing = await index.list_dir(database_idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]

        dir_lookup = await index.get(database_idx_key)
        if dir_lookup.entry is None and index is not NULL_INDEX:
            parent = PathSpec(
                virtual=prefix + "/databases",
                directory=prefix + "/databases",
                resource_path=mount_key(prefix + "/databases", prefix),
            )
            await readdir(accessor, parent, index)
            dir_lookup = await index.get(database_idx_key)
        database_json_size = (dir_lookup.entry.extra.get("database_json_size")
                              if dir_lookup.entry else None)

        database = await get_database(accessor.config, database_id)
        entries = []
        database_json_entry = IndexEntry(
            id=f"{database_id}:database",
            name="database.json",
            resource_type="file",
            vfs_name="database.json",
            size=database_json_size,
        )
        entries.append(("database.json", database_json_entry))
        for stub in database.get("data_sources", []):
            dirname = data_source_dirname(stub)
            source_entry = IndexEntry(
                id=stub["id"],
                name=dirname,
                resource_type="notion/data_source",
                remote_time=database.get("last_edited_time", ""),
                vfs_name=dirname,
            )
            entries.append((dirname, source_entry))

        await index.set_dir(database_idx_key, entries)

        base = f"{prefix}/{key}"
        return [f"{base}/{name}" for name, _ in entries]

    if len(parts) == 3 and parts[0] == "databases":
        _, data_source_id = split_suffix_id(parts[2])
        source_idx_key = "/" + "/".join(parts)

        listing = await index.list_dir(source_idx_key)
        if listing.entries is not None:
            return [f"{prefix}{entry}" for entry in listing.entries]

        data_source = await get_data_source(accessor.config, data_source_id)
        rows = await query_data_source(accessor.config, data_source_id)
        entries = []
        source_json_entry = IndexEntry(
            id=f"{data_source_id}:data_source",
            name="data_source.json",
            resource_type="file",
            vfs_name="data_source.json",
            size=len(to_json_bytes(normalize_data_source(data_source))),
        )
        entries.append(("data_source.json", source_json_entry))
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

        await index.set_dir(source_idx_key, entries)

        base = f"{prefix}/{key}"
        return [f"{base}/{name}" for name, _ in entries]

    return []
