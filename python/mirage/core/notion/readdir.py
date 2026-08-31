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
from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.notion.normalize import (normalize_data_source,
                                          normalize_database, to_json_bytes)
from mirage.core.notion.pages import (get_data_source, get_database,
                                      list_block_children, query_data_source,
                                      search_data_sources, search_pages)
from mirage.core.notion.pathing import (data_source_dirname, database_dirname,
                                        format_segment, page_dirname)
from mirage.core.notion.scope import detect_scope


async def _list_pages_root(accessor: NotionAccessor,
                           match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    pages = await search_pages(accessor.config, session=accessor.pool)
    top_level = [
        p for p in pages if p.get("parent", {}).get("type") == "workspace"
    ]
    entries = []
    for page in top_level:
        dirname = page_dirname(page)
        entries.append((dirname,
                        IndexEntry(
                            id=page["id"],
                            name=dirname,
                            resource_type="notion/page",
                            remote_time=page.get("last_edited_time", ""),
                            vfs_name=dirname,
                        )))
    return entries


async def _list_databases_root(
        accessor: NotionAccessor,
        match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    # Search answers with data sources since 2025-09-03, so the set of
    # databases is their distinct parents. Each one still costs a
    # retrieve, because only the database object carries the title and
    # url this directory is named and rendered from.
    seen: list[str] = []
    for data_source in await search_data_sources(accessor.config,
                                                 session=accessor.pool):
        owner = data_source.get("parent", {}).get("database_id", "")
        if owner and owner not in seen:
            seen.append(owner)
    entries = []
    for database_id in seen:
        database = await get_database(accessor.config,
                                      database_id,
                                      session=accessor.pool)
        dirname = database_dirname(database)
        entries.append((dirname,
                        IndexEntry(
                            id=database_id,
                            name=dirname,
                            resource_type="notion/database",
                            remote_time=database.get("last_edited_time", ""),
                            vfs_name=dirname,
                        )))
    return entries


async def _list_page(accessor: NotionAccessor,
                     match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    page_id = match.slots["page_id"]
    blocks = await list_block_children(accessor.config,
                                       page_id,
                                       session=accessor.pool)
    child_pages = [b for b in blocks if b.get("type") == "child_page"]

    # page.json renders from get_page plus the *recursive* block tree
    # while this listing only holds one level of children, so sizing it
    # here would cost an extra call pair per page. It stays size-unknown
    # until a read hydrates it.
    entries = [("page.json",
                IndexEntry(
                    id=f"{page_id}:page",
                    name="page.json",
                    resource_type="file",
                    vfs_name="page.json",
                ))]
    for child_block in child_pages:
        child_title = child_block.get("child_page",
                                      {}).get("title", "untitled")
        child_id = child_block["id"]
        dirname = format_segment(child_title, child_id)
        entries.append(
            (dirname,
             IndexEntry(
                 id=child_id,
                 name=dirname,
                 resource_type="notion/page",
                 remote_time=child_block.get("last_edited_time", ""),
                 vfs_name=dirname,
             )))
    return entries


async def _list_database(accessor: NotionAccessor,
                         match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    database_id = match.slots["database_id"]
    database = await get_database(accessor.config,
                                  database_id,
                                  session=accessor.pool)
    # database.json renders the database object this listing already
    # fetched, so its exact size is free here.
    entries = [("database.json",
                IndexEntry(
                    id=f"{database_id}:database",
                    name="database.json",
                    resource_type="file",
                    vfs_name="database.json",
                    size=len(to_json_bytes(normalize_database(database))),
                ))]
    for stub in database.get("data_sources", []):
        dirname = data_source_dirname(stub)
        entries.append((dirname,
                        IndexEntry(
                            id=stub["id"],
                            name=dirname,
                            resource_type="notion/data_source",
                            remote_time=database.get("last_edited_time", ""),
                            vfs_name=dirname,
                        )))
    return entries


async def _list_data_source(accessor: NotionAccessor,
                            match: ScopeMatch) -> list[tuple[str, IndexEntry]]:
    data_source_id = match.slots["data_source_id"]
    data_source = await get_data_source(accessor.config,
                                        data_source_id,
                                        session=accessor.pool)
    rows = await query_data_source(accessor.config,
                                   data_source_id,
                                   session=accessor.pool)
    entries = [
        ("data_source.json",
         IndexEntry(
             id=f"{data_source_id}:data_source",
             name="data_source.json",
             resource_type="file",
             vfs_name="data_source.json",
             size=len(to_json_bytes(normalize_data_source(data_source))),
         ))
    ]
    for row in rows:
        if row.get("object") != "page":
            continue
        dirname = page_dirname(row)
        entries.append((dirname,
                        IndexEntry(
                            id=row["id"],
                            name=dirname,
                            resource_type="notion/page",
                            remote_time=row.get("last_edited_time", ""),
                            vfs_name=dirname,
                        )))
    return entries


readdir = make_readdir(
    detect_scope,
    listers={
        "pages": _list_pages_root,
        "databases": _list_databases_root,
        "page": _list_page,
        "database": _list_database,
        "data_source": _list_data_source,
    },
    static_root=("pages", "databases"),
)
