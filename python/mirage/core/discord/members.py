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

from mirage.core.discord._client import discord_get
from mirage.core.discord.paginate import after_id_pages
from mirage.resource.discord.config import DiscordConfig


def _member_user_id(m: dict[str, Any]) -> str:
    return m.get("user", {}).get("id", "")


def list_members_stream(
    config: DiscordConfig,
    guild_id: str,
    page_size: int = 1000,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Stream guild members across pages.

    Walks ``/guilds/<id>/members?after=<user_id>&limit=N`` until the
    API returns a partial page.

    Args:
        config (DiscordConfig): Discord credentials.
        guild_id (str): guild ID.
        page_size (int): per-page limit (Discord caps at 1000).

    Yields:
        list[dict]: member dicts per page.
    """
    return after_id_pages(
        config,
        f"/guilds/{guild_id}/members",
        base_params={},
        last_id_fn=_member_user_id,
        page_size=page_size,
    )


async def list_members(
    config: DiscordConfig,
    guild_id: str,
    page_size: int = 1000,
) -> list[dict[str, Any]]:
    """List all guild members (paginated).

    Args:
        config (DiscordConfig): Discord credentials.
        guild_id (str): guild ID.
        page_size (int): per-page limit.

    Returns:
        list[dict]: member dicts.
    """
    out: list[dict[str, Any]] = []
    async for page in list_members_stream(config, guild_id, page_size):
        out.extend(page)
    return out


async def search_members(
    config: DiscordConfig,
    guild_id: str,
    query: str,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Search guild members by name.

    Args:
        config (DiscordConfig): Discord credentials.
        guild_id (str): guild ID.
        query (str): search query.
        limit (int): max results.

    Returns:
        list[dict]: matching members.
    """
    result = await discord_get(
        config,
        f"/guilds/{guild_id}/members/search",
        params={
            "query": query,
            "limit": limit
        },
    )
    return result if isinstance(result, list) else []
