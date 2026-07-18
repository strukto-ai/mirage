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

from mirage.core.notion._client import (notion_get, notion_patch, notion_post,
                                        paginate_list, paginate_post)
from mirage.resource.notion.config import NotionConfig


async def search_pages(
    config: NotionConfig,
    query: str = "",
    page_size: int = 100,
) -> list[dict[str, Any]]:
    body: dict[str, Any] = {
        "filter": {
            "value": "page",
            "property": "object"
        },
    }
    if query:
        body["query"] = query
    return await paginate_post(config, "/search", body, page_size=page_size)


async def search_databases(
    config: NotionConfig,
    query: str = "",
    page_size: int = 100,
) -> list[dict[str, Any]]:
    body: dict[str, Any] = {
        "filter": {
            "value": "database",
            "property": "object"
        },
    }
    if query:
        body["query"] = query
    return await paginate_post(config, "/search", body, page_size=page_size)


async def get_database(config: NotionConfig,
                       database_id: str) -> dict[str, Any]:
    return await notion_get(config, f"/databases/{database_id}")


async def query_database(
    config: NotionConfig,
    database_id: str,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    return await paginate_post(
        config,
        f"/databases/{database_id}/query",
        {},
        page_size=page_size,
    )


async def get_page(config: NotionConfig, page_id: str) -> dict[str, Any]:
    return await notion_get(config, f"/pages/{page_id}")


async def list_block_children(
    config: NotionConfig,
    block_id: str,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    return await paginate_list(
        config,
        f"/blocks/{block_id}/children",
        page_size=page_size,
    )


MAX_BLOCK_DEPTH = 10


async def list_block_tree(
    config: NotionConfig,
    block_id: str,
    depth: int = 0,
) -> list[dict[str, Any]]:
    """List block children recursively, embedding nested blocks.

    Blocks with ``has_children`` get their descendants attached under a
    ``children`` key, except ``child_page``/``child_database`` whose
    children belong to a different page. Recursion stops at
    ``MAX_BLOCK_DEPTH``.

    Args:
        config (NotionConfig): notion API config.
        block_id (str): page or block id whose children to list.
        depth (int): current recursion depth.

    Returns:
        list[dict]: top-level child blocks with nested ``children``.
    """
    blocks = await list_block_children(config, block_id)
    if depth >= MAX_BLOCK_DEPTH:
        return blocks
    for block in blocks:
        if block.get("type") in ("child_page", "child_database"):
            continue
        if block.get("has_children"):
            block["children"] = await list_block_tree(
                config,
                block["id"],
                depth + 1,
            )
    return blocks


async def create_page(config: NotionConfig, body: dict[str,
                                                       Any]) -> dict[str, Any]:
    return await notion_post(config, "/pages", body)


async def append_blocks(config: NotionConfig, block_id: str,
                        body: dict[str, Any]) -> dict[str, Any]:
    return await notion_patch(config, f"/blocks/{block_id}/children", body)


async def create_comment(config: NotionConfig,
                         body: dict[str, Any]) -> dict[str, Any]:
    return await notion_post(config, "/comments", body)
