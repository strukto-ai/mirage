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

from collections.abc import AsyncIterator, Callable
from typing import Any

from mirage.core.discord._client import discord_get
from mirage.resource.discord.config import DiscordConfig


async def after_id_pages(
    config: DiscordConfig,
    endpoint: str,
    base_params: dict[str, Any],
    last_id_fn: Callable[[dict[str, Any]], str],
    page_size: int = 100,
    start_after: str = "0",
) -> AsyncIterator[list[dict[str, Any]]]:
    """Walk an after-id paginated Discord endpoint.

    Used for endpoints that return a flat list and accept `after=<id>` +
    `limit=<n>` for pagination (history, members, guilds).

    Args:
        config (DiscordConfig): Discord credentials.
        endpoint (str): Discord API path, e.g. "/channels/X/messages".
        base_params (dict): per-request params; "after" + "limit" are set
            here.
        last_id_fn (Callable[[dict], str]): extract the cursor id from
            the last item of a page (e.g. ``lambda m: m["id"]`` for
            messages, ``lambda m: m["user"]["id"]`` for members).
        page_size (int): per-page limit (Discord caps vary by endpoint).
        start_after (str): initial "after" cursor.

    Yields:
        list[dict]: items in each page. Generator returns when the API
        returns an empty page or a partial page (signalling end).
    """
    last = start_after
    while True:
        params = dict(base_params)
        params["after"] = last
        params["limit"] = page_size
        data = await discord_get(config, endpoint, params=params)
        if not isinstance(data, list) or not data:
            return
        yield data
        if len(data) < page_size:
            return
        last = last_id_fn(data[-1])


def _get_nested(d: dict[str, Any], path: tuple[str, ...]) -> Any:
    cur: Any = d
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


async def offset_pages(
    config: DiscordConfig,
    endpoint: str,
    base_params: dict[str, Any],
    items_path: tuple[str, ...],
    total_key: str = "total_results",
    page_size: int = 25,
    start_offset: int = 0,
    max_pages: int | None = None,
) -> AsyncIterator[list[Any]]:
    """Walk an offset-paginated Discord endpoint (search).

    Args:
        config (DiscordConfig): Discord credentials.
        endpoint (str): Discord API path, e.g.
            "/guilds/X/messages/search".
        base_params (dict): per-request params; "offset" is set here.
        items_path (tuple[str, ...]): nested path to items list in the
            response, e.g. ``("messages",)`` for search.
        total_key (str): top-level key holding the total result count.
        page_size (int): per-page count (Discord search returns 25).
        start_offset (int): initial offset.
        max_pages (int | None): cap on pages fetched; None = unbounded.

    Yields:
        list[Any]: items from each page (search returns context arrays;
        the caller flattens).
    """
    offset = start_offset
    total: int | None = None
    fetched = 0
    while True:
        params = dict(base_params)
        params["offset"] = offset
        data = await discord_get(config, endpoint, params=params)
        if not isinstance(data, dict):
            return
        items = _get_nested(data, items_path) or []
        if not items:
            return
        yield items
        fetched += 1
        if total is None:
            total = data.get(total_key, 0)
        offset += page_size
        if total is not None and offset >= total:
            return
        if max_pages is not None and fetched >= max_pages:
            return
