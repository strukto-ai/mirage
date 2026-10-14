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

from collections.abc import AsyncGenerator, Callable, Mapping
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

from mirage.core.api.errors import PaginationStalledError
from mirage.types import PageFetch


def has_more_cursor(data: Mapping[str, Any]) -> str | None:
    """Notion's continuation: ``next_cursor``, while ``has_more`` holds.

    Args:
        data (Mapping[str, Any]): one decoded reply.
    """
    cursor = data.get("next_cursor")
    if not data.get("has_more") or not isinstance(cursor, str) or not cursor:
        return None
    return cursor


def offset_cursor(data: Mapping[str, Any]) -> str | None:
    """Airtable's continuation: an ``offset`` on every page but the last.

    Records drop the key on the last page and comments send it as null;
    both read as the end.

    Args:
        data (Mapping[str, Any]): one decoded reply.
    """
    cursor = data.get("offset")
    if not isinstance(cursor, str) or not cursor:
        return None
    return cursor


@dataclass(frozen=True, slots=True)
class PageShape:
    """Where a cursor-paginated reply keeps its items and its cursor.

    Args:
        items_key (str): the reply field holding the page's items.
        next_cursor (Callable[[Mapping[str, Any]], str | None]): reads
            the resume cursor off a reply; None ends the walk.
    """

    items_key: str = "results"
    next_cursor: Callable[[Mapping[str, Any]], str | None] = has_more_cursor


HAS_MORE_PAGES = PageShape()


async def cursor_items(
    fetch_page: PageFetch,
    max_results: int | None = None,
    *,
    shape: PageShape = HAS_MORE_PAGES,
) -> list[Any]:
    """Collect every item from a cursor-paginated endpoint.

    The default reply protocol is the ``results`` / ``has_more`` /
    ``next_cursor`` shape (Notion's); ``shape`` names another one (an
    Airtable list is ``records`` plus an ``offset`` that vanishes on the
    last page). Where the resume cursor goes on the request — a
    ``start_cursor`` body field, a query parameter — is the caller's, so
    ``fetch_page`` owns that merge. Pagination stops when the reply stops
    naming a cursor, and fails when it names one it already sent.

    Args:
        fetch_page (PageFetch): performs one page request; receives the
            cursor to resume from, or None for the first page.
        max_results (int | None): stop after this many items; the tail of
            the last page is sliced off.
        shape (PageShape): where the reply keeps its items and cursor.

    Raises:
        PaginationStalledError: the endpoint repeated a cursor.
    """
    collected: list[Any] = []
    async with aclosing(cursor_pages(fetch_page, shape=shape)) as pages:
        async for page in pages:
            collected.extend(page)
            if max_results is not None and len(collected) >= max_results:
                return collected[:max_results]
    return collected


async def cursor_pages(
    fetch_page: PageFetch, *, shape: PageShape = HAS_MORE_PAGES
) -> AsyncGenerator[list[Any], None]:
    """Each page's items from a cursor-paginated endpoint, the next page
    fetched only when the caller pulls it.

    Args:
        fetch_page (PageFetch): performs one page request; receives the
            cursor to resume from, or None for the first page.
        shape (PageShape): where the reply keeps its items and cursor.

    Raises:
        PaginationStalledError: the endpoint repeated a cursor.
    """
    seen: set[str] = set()
    cursor: str | None = None
    while True:
        data = await fetch_page(cursor)
        page = data.get(shape.items_key)
        yield page if isinstance(page, list) else []
        cursor = shape.next_cursor(data)
        if cursor is None:
            return
        if cursor in seen:
            raise PaginationStalledError(cursor)
        seen.add(cursor)
