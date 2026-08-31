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

from mirage.core.api.client import SessionArg
from mirage.core.notion.client import (notion_get, notion_patch, notion_post,
                                       paginate_list, paginate_post)
from mirage.core.notion.config import NotionConfig


async def search_pages(
    config: NotionConfig,
    query: str = "",
    page_size: int = 100,
    max_results: int | None = None,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    body: dict[str, Any] = {
        "filter": {
            "value": "page",
            "property": "object"
        },
    }
    if query:
        body["query"] = query
    return await paginate_post(
        config,
        "/search",
        body,
        page_size=page_size,
        max_results=max_results,
        session=session,
    )


async def search_data_sources(
    config: NotionConfig,
    query: str = "",
    page_size: int = 100,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    body: dict[str, Any] = {
        "filter": {
            "value": "data_source",
            "property": "object"
        },
    }
    if query:
        body["query"] = query
    return await paginate_post(config,
                               "/search",
                               body,
                               page_size=page_size,
                               session=session)


async def get_database(config: NotionConfig,
                       database_id: str,
                       session: SessionArg = None) -> dict[str, Any]:
    return await notion_get(config,
                            f"/databases/{database_id}",
                            session=session)


async def get_data_source(config: NotionConfig,
                          data_source_id: str,
                          session: SessionArg = None) -> dict[str, Any]:
    return await notion_get(config,
                            f"/data_sources/{data_source_id}",
                            session=session)


async def query_data_source(
    config: NotionConfig,
    data_source_id: str,
    page_size: int = 100,
    body: dict[str, Any] | None = None,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    return await paginate_post(
        config,
        f"/data_sources/{data_source_id}/query",
        body or {},
        page_size=page_size,
        session=session,
    )


async def query_data_source_page(config: NotionConfig,
                                 data_source_id: str,
                                 body: dict[str, Any],
                                 session: SessionArg = None) -> dict[str, Any]:
    """Query one page of rows, cursor envelope intact.

    ``ntn datasources query`` is explicitly one page at a time: it
    honors ``--limit``, reports ``has_more`` and hands the caller the
    cursor, so it cannot use the paginating helper the mount uses.

    Args:
        config (NotionConfig): notion API config.
        data_source_id (str): the data source to query.
        body (dict[str, Any]): the request body, page size included.
        session (SessionArg): pool or live session to ride.

    Returns:
        dict: the raw list response.
    """
    return await notion_post(config,
                             f"/data_sources/{data_source_id}/query",
                             body,
                             session=session)


async def get_page(config: NotionConfig,
                   page_id: str,
                   session: SessionArg = None) -> dict[str, Any]:
    return await notion_get(config, f"/pages/{page_id}", session=session)


async def get_self(config: NotionConfig,
                   session: SessionArg = None) -> dict[str, Any]:
    return await notion_get(config, "/users/me", session=session)


async def get_page_markdown(config: NotionConfig,
                            page_id: str,
                            session: SessionArg = None) -> dict[str, Any]:
    return await notion_get(config,
                            f"/pages/{page_id}/markdown",
                            session=session)


async def replace_page_markdown(config: NotionConfig,
                                page_id: str,
                                markdown: str,
                                session: SessionArg = None) -> dict[str, Any]:
    return await notion_patch(config,
                              f"/pages/{page_id}/markdown", {
                                  "type": "replace_content",
                                  "replace_content": {
                                      "new_str": markdown
                                  },
                              },
                              session=session)


async def list_block_children(
    config: NotionConfig,
    block_id: str,
    page_size: int = 100,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    return await paginate_list(
        config,
        f"/blocks/{block_id}/children",
        page_size=page_size,
        session=session,
    )


MAX_BLOCK_DEPTH = 10


async def list_block_tree(
    config: NotionConfig,
    block_id: str,
    depth: int = 0,
    session: SessionArg = None,
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
        session (SessionArg): pool or live session every page of the
            walk rides, nested levels included.

    Returns:
        list[dict]: top-level child blocks with nested ``children``.
    """
    blocks = await list_block_children(config, block_id, session=session)
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
                session=session,
            )
    return blocks


async def create_page(config: NotionConfig,
                      body: dict[str, Any],
                      session: SessionArg = None) -> dict[str, Any]:
    return await notion_post(config, "/pages", body, session=session)


async def append_blocks(config: NotionConfig,
                        block_id: str,
                        body: dict[str, Any],
                        session: SessionArg = None) -> dict[str, Any]:
    return await notion_patch(config,
                              f"/blocks/{block_id}/children",
                              body,
                              session=session)


async def create_comment(config: NotionConfig,
                         body: dict[str, Any],
                         session: SessionArg = None) -> dict[str, Any]:
    return await notion_post(config, "/comments", body, session=session)


async def update_page(config: NotionConfig,
                      page_id: str,
                      body: dict[str, Any],
                      session: SessionArg = None) -> dict[str, Any]:
    return await notion_patch(config,
                              f"/pages/{page_id}",
                              body,
                              session=session)
