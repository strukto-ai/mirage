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

from collections.abc import AsyncIterator
from typing import Any

from mirage.core.discord.paginate import offset_pages
from mirage.resource.discord.config import DiscordConfig

PAGE_SIZE = 25


def _flatten_contexts(contexts: list[Any]) -> list[dict[str, Any]]:
    """Pull the matched message from each search-context array.

    Discord search responses are shaped as ``[[ctx_msg, ...], ...]``;
    the matched message is the first entry of each context.
    """
    out: list[dict[str, Any]] = []
    for context in contexts:
        if isinstance(context, list) and context:
            out.append(context[0])
    return out


async def search_guild_stream(
    config: DiscordConfig,
    guild_id: str,
    query: str,
    channel_id: str | None = None,
    max_pages: int | None = None,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Stream guild-search pages, one flattened batch per round-trip.

    Args:
        config (DiscordConfig): credentials.
        guild_id (str): guild snowflake ID.
        query (str): search text (content match).
        channel_id (str | None): filter to specific channel.
        max_pages (int | None): cap on pages fetched.

    Yields:
        list[dict]: matched message dicts per page (flattened from
        Discord's context arrays).
    """
    base_params: dict[str, str | int] = {"content": query}
    if channel_id:
        base_params["channel_id"] = channel_id
    async for raw in offset_pages(
            config,
            f"/guilds/{guild_id}/messages/search",
            base_params=base_params,
            items_path=("messages", ),
            total_key="total_results",
            page_size=PAGE_SIZE,
            max_pages=max_pages,
    ):
        flat = _flatten_contexts(raw)
        if flat:
            yield flat


async def search_guild(
    config: DiscordConfig,
    guild_id: str,
    query: str,
    channel_id: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Search messages in a guild, optionally filtered to one channel.

    Args:
        config (DiscordConfig): credentials.
        guild_id (str): guild snowflake ID.
        query (str): search text (content match).
        channel_id (str | None): filter to specific channel.
        limit (int): max results to return.

    Returns:
        list[dict]: matching messages sorted oldest-first.
    """
    messages: list[dict[str, Any]] = []
    async for page in search_guild_stream(config, guild_id, query, channel_id):
        for msg in page:
            messages.append(msg)
            if len(messages) >= limit:
                break
        if len(messages) >= limit:
            break
    messages.sort(key=lambda m: int(m.get("id", 0)))
    return messages[:limit]
