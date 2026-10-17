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

from collections.abc import AsyncGenerator
from contextlib import aclosing

from mirage.accessor.notion import NotionAccessor
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.notion.normalize import (
    normalize_data_source,
    normalize_database,
    normalize_page,
    normalize_row,
    to_json_bytes,
)
from mirage.core.notion.pages import (
    get_data_source,
    get_database,
    get_page,
    list_block_tree,
    query_data_source_pages,
)
from mirage.core.notion.resolve import guard_row, resolve_row
from mirage.core.notion.scope import detect_scope
from mirage.core.render.json import jsonl_bytes
from mirage.errors.fs import enoent
from mirage.io.types import materialize
from mirage.types import FileStat, PathSpec


async def read_page_json(accessor: NotionAccessor, page_id: str) -> bytes:
    page = await get_page(accessor, page_id)
    blocks = await list_block_tree(accessor, page_id)
    normalized = normalize_page(page, blocks)
    return to_json_bytes(normalized)


async def _read_page_json(
    accessor: NotionAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    if match.kind == "row_json":
        page = await resolve_row(accessor, match, path.virtual)
        blocks = await list_block_tree(accessor, match.slots["row_id"])
        return to_json_bytes(normalize_page(page, blocks))
    await guard_row(accessor, match, path.virtual)
    return await read_page_json(accessor, match.slots["page_id"])


async def _read_database_json(
    accessor: NotionAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    database = await get_database(accessor, match.slots["database_id"])
    return to_json_bytes(normalize_database(database))


async def _read_data_source_json(
    accessor: NotionAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    data_source = await get_data_source(
        accessor, match.slots["data_source_id"]
    )
    return to_json_bytes(normalize_data_source(data_source))


async def _read_rows_jsonl(
    accessor: NotionAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    return await materialize(_rows_jsonl(accessor, match))


async def _rows_jsonl(
    accessor: NotionAccessor, match: ScopeMatch, limit: int | None = None
) -> AsyncGenerator[bytes, None]:
    if limit is not None and limit <= 0:
        return
    pages = query_data_source_pages(accessor, match.slots["data_source_id"])
    async with aclosing(pages):
        async for page in pages:
            rows = [row for row in page if row.get("object") == "page"]
            if limit is not None:
                rows = rows[:limit]
                limit -= len(rows)
            if rows:
                yield jsonl_bytes([normalize_row(row) for row in rows])
            if limit == 0:
                return


read = make_read(
    detect_scope,
    parented=True,
    readers={
        "page_json": _read_page_json,
        "row_json": _read_page_json,
        "database_json": _read_database_json,
        "data_source_json": _read_data_source_json,
        "rows_jsonl": _read_rows_jsonl,
    },
)


async def read_stream(
    accessor: NotionAccessor,
    path: PathSpec,
    parent: FileStat | None = None,
) -> AsyncGenerator[bytes, None]:
    """Render rows one query page at a time; read other files whole.

    Args:
        accessor (NotionAccessor): the account.
        path (PathSpec): the file.
        parent (FileStat | None): the parent directory from its listing.
    """
    match = detect_scope(path)
    if match.kind != "rows_jsonl":
        yield await read(accessor, path, None, parent)
        return
    if parent is None:
        raise enoent(path.virtual)
    async with aclosing(_rows_jsonl(accessor, match)) as stream:
        async for chunk in stream:
            yield chunk


async def first_lines(
    accessor: NotionAccessor,
    path: PathSpec,
    n: int,
    parent: FileStat | None = None,
) -> bytes | None:
    """Render only the first n rows, closing before the next query page.

    Args:
        accessor (NotionAccessor): the account.
        path (PathSpec): the file.
        n (int): maximum number of lines.
        parent (FileStat | None): the parent directory from its listing.
    """
    match = detect_scope(path)
    if match.kind != "rows_jsonl":
        return None
    if parent is None:
        raise enoent(path.virtual)
    return await materialize(_rows_jsonl(accessor, match, n))
