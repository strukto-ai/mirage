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
from mirage.core.hierarchy.readdir import make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import entry_stat
from mirage.core.notion.normalize import (
    data_source_segment_name,
    database_segment_name,
    normalize_data_source,
    normalize_database,
    page_segment_name,
    to_json_bytes,
)
from mirage.core.notion.pages import (
    get_data_source,
    get_database,
    list_block_children,
    search_data_sources,
    search_pages,
)
from mirage.core.notion.pathing import (
    format_segment,
)
from mirage.core.notion.resolve import guard_row
from mirage.core.notion.scope import detect_scope
from mirage.types import DirListing, FileStat, FileType

PAGE = entry_stat("page_id", FileType.DIRECTORY)
DATABASE = entry_stat("database_id", FileType.DIRECTORY)
DATA_SOURCE = entry_stat("data_source_id", FileType.DIRECTORY)


async def _list_pages_root(
    accessor: NotionAccessor, match: ScopeMatch
) -> list[FileStat]:
    pages = await search_pages(accessor)
    return [
        PAGE(
            page_segment_name(page),
            page["id"],
            modified=page.get("last_edited_time"),
        )
        for page in pages
        if page.get("parent", {}).get("type") == "workspace"
    ]


async def _list_databases_root(
    accessor: NotionAccessor, match: ScopeMatch
) -> list[FileStat]:
    # Search answers with data sources since 2025-09-03, so the set of
    # databases is their distinct parents. Each one still costs a
    # retrieve, because only the database object carries the title and
    # url this directory is named and rendered from.
    seen: list[str] = []
    for data_source in await search_data_sources(accessor):
        owner = data_source.get("parent", {}).get("database_id", "")
        if owner and owner not in seen:
            seen.append(owner)
    rows = []
    for database_id in seen:
        database = await get_database(accessor, database_id)
        rows.append(
            DATABASE(
                database_segment_name(database),
                database_id,
                modified=database.get("last_edited_time"),
            )
        )
    return rows


async def _list_page(
    accessor: NotionAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    page_id = match.slots.get("page_id") or match.slots["row_id"]
    blocks = await list_block_children(accessor, page_id)
    # page.json renders from get_page plus the *recursive* block tree
    # while this listing only holds one level of children, so sizing it
    # here would cost an extra call pair per page. It stays size-unknown
    # until a read hydrates it.
    rows = [FileStat(name="page.json", type=FileType.FILE)]
    for child_block in blocks:
        if child_block.get("type") != "child_page":
            continue
        child_title = child_block.get("child_page", {}).get(
            "title", "untitled"
        )
        rows.append(
            PAGE(
                format_segment(child_title, child_block["id"]),
                child_block["id"],
                modified=child_block.get("last_edited_time"),
            )
        )
    return rows


async def _list_database(
    accessor: NotionAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    database_id = match.slots["database_id"]
    database = await get_database(accessor, database_id)
    # database.json renders the database object this listing already
    # fetched, so its exact size is free here.
    rows = [
        FileStat(
            name="database.json",
            type=FileType.FILE,
            size=len(to_json_bytes(normalize_database(database))),
            extra={"database_id": database_id},
        )
    ]
    for stub in database.get("data_sources", []):
        rows.append(
            DATA_SOURCE(
                data_source_segment_name(stub),
                stub["id"],
                modified=database.get("last_edited_time"),
            )
        )
    return rows


async def _list_data_source(
    accessor: NotionAccessor, match: ScopeMatch, entry: FileStat
) -> DirListing:
    data_source_id = match.slots["data_source_id"]
    data_source = await get_data_source(accessor, data_source_id)
    # The rows are one file, not one directory each: a query answers a
    # hundred rows' cells a call, while a row directory costs calls of its
    # own to enter, so a walk over a table stays a walk over its pages of
    # query results. rows.jsonl stays size-unknown until a read renders it.
    # A row is still a directory its path reaches, which this listing
    # does not name, so the listing proves nothing absent.
    extra = {"data_source_id": data_source_id}
    return DirListing(
        entries=[
            FileStat(
                name="data_source.json",
                type=FileType.FILE,
                size=len(to_json_bytes(normalize_data_source(data_source))),
                extra=extra,
            ),
            FileStat(name="rows.jsonl", type=FileType.FILE, extra=extra),
        ],
        window=True,
    )


readdir = make_readdir(
    detect_scope,
    listers={
        "pages": _list_pages_root,
        "databases": _list_databases_root,
    },
    parent_entry_listers={"row": _list_page},
    entry_listers={
        "page": _list_page,
        "database": _list_database,
        "data_source": _list_data_source,
    },
    static_root=("pages", "databases"),
    guards={"row": guard_row, "page": guard_row},
)
