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
from typing import Any

from mirage.accessor.notion import NotionAccessor
from mirage.core.api.paginate import cursor_pages
from mirage.core.notion.client import (
    complete_page,
    notion_get,
    notion_patch,
    notion_post,
    paginate_list,
    paginate_post,
)
from mirage.core.notion.constants import MAX_PAGE_SIZE


async def search_pages(
    accessor: NotionAccessor,
    query: str = "",
    page_size: int = 100,
    max_results: int | None = None,
) -> list[dict[str, Any]]:
    body: dict[str, Any] = {
        "filter": {"value": "page", "property": "object"},
    }
    if query:
        body["query"] = query
    return await paginate_post(
        accessor, "/search", body, page_size=page_size, max_results=max_results
    )


async def search_data_sources(
    accessor: NotionAccessor, query: str = "", page_size: int = 100
) -> list[dict[str, Any]]:
    body: dict[str, Any] = {
        "filter": {"value": "data_source", "property": "object"},
    }
    if query:
        body["query"] = query
    return await paginate_post(accessor, "/search", body, page_size=page_size)


async def get_database(
    accessor: NotionAccessor, database_id: str
) -> dict[str, Any]:
    return await notion_get(accessor, f"/databases/{database_id}")


async def get_data_source(
    accessor: NotionAccessor, data_source_id: str
) -> dict[str, Any]:
    return await notion_get(accessor, f"/data_sources/{data_source_id}")


async def query_data_source(
    accessor: NotionAccessor,
    data_source_id: str,
    page_size: int = 100,
    body: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    async with aclosing(
        query_data_source_pages(accessor, data_source_id, page_size, body)
    ) as pages:
        async for page in pages:
            rows.extend(page)
    return rows


async def query_data_source_pages(
    accessor: NotionAccessor,
    data_source_id: str,
    page_size: int = 100,
    body: dict[str, Any] | None = None,
) -> AsyncGenerator[list[dict[str, Any]], None]:
    """Yield query pages only as the caller requests them.

    Each page is checked for an incomplete response before yielding its
    rows. Closing the iterator prevents further requests; the shared
    cursor walker retains its repeated-cursor and terminal-page rules.

    Args:
        accessor (NotionAccessor): the account's config and pool.
        data_source_id (str): the data source to query.
        page_size (int): rows per request, capped at the API maximum.
        body (dict[str, Any] | None): query options, never mutated.
    """
    merged = dict(body or {})
    merged["page_size"] = min(page_size, MAX_PAGE_SIZE)

    async def fetch_page(cursor: str | None) -> dict[str, Any]:
        request = dict(merged)
        if cursor is not None:
            request["start_cursor"] = cursor
        return await query_data_source_page(accessor, data_source_id, request)

    async with aclosing(cursor_pages(fetch_page)) as pages:
        async for page in pages:
            yield page


async def query_data_source_page(
    accessor: NotionAccessor, data_source_id: str, body: dict[str, Any]
) -> dict[str, Any]:
    """Query one page of rows, cursor envelope intact.

    ``ntn datasources query`` is explicitly one page at a time: it
    honors ``--limit``, reports ``has_more`` and hands the caller the
    cursor, so it cannot use the paginating helper the mount uses.

    Args:
        accessor (NotionAccessor): the account's config and pool.
        data_source_id (str): the data source to query.
        body (dict[str, Any]): the request body, page size included.

    Returns:
        dict: the raw list response.

    Raises:
        NotionAPIError: when Notion marks the page incomplete, so a
            truncated result never prints as a successful query.
    """
    page = await notion_post(
        accessor, f"/data_sources/{data_source_id}/query", body
    )
    return complete_page(page)


async def get_page(accessor: NotionAccessor, page_id: str) -> dict[str, Any]:
    return await notion_get(accessor, f"/pages/{page_id}")


async def get_self(accessor: NotionAccessor) -> dict[str, Any]:
    return await notion_get(accessor, "/users/me")


async def get_page_markdown(
    accessor: NotionAccessor, page_id: str
) -> dict[str, Any]:
    return await notion_get(accessor, f"/pages/{page_id}/markdown")


async def replace_page_markdown(
    accessor: NotionAccessor, page_id: str, markdown: str
) -> dict[str, Any]:
    return await notion_patch(
        accessor,
        f"/pages/{page_id}/markdown",
        {
            "type": "replace_content",
            "replace_content": {"new_str": markdown},
        },
    )


async def list_block_children(
    accessor: NotionAccessor, block_id: str, page_size: int = 100
) -> list[dict[str, Any]]:
    return await paginate_list(
        accessor, f"/blocks/{block_id}/children", page_size=page_size
    )


MAX_BLOCK_DEPTH = 10


async def list_block_tree(
    accessor: NotionAccessor, block_id: str, depth: int = 0
) -> list[dict[str, Any]]:
    """List block children recursively, embedding nested blocks.

    Blocks with ``has_children`` get their descendants attached under a
    ``children`` key, except ``child_page``/``child_database`` whose
    children belong to a different page. Recursion stops at
    ``MAX_BLOCK_DEPTH``.

    Args:
        accessor (NotionAccessor): the account's config and pool.
        block_id (str): page or block id whose children to list.
        depth (int): current recursion depth.

    Returns:
        list[dict]: top-level child blocks with nested ``children``.
    """
    blocks = await list_block_children(accessor, block_id)
    if depth >= MAX_BLOCK_DEPTH:
        return blocks
    for block in blocks:
        if block.get("type") in ("child_page", "child_database"):
            continue
        if block.get("has_children"):
            block["children"] = await list_block_tree(
                accessor, block["id"], depth + 1
            )
    return blocks


async def create_page(
    accessor: NotionAccessor, body: dict[str, Any]
) -> dict[str, Any]:
    return await notion_post(accessor, "/pages", body)


async def update_page(
    accessor: NotionAccessor, page_id: str, body: dict[str, Any]
) -> dict[str, Any]:
    return await notion_patch(accessor, f"/pages/{page_id}", body)
