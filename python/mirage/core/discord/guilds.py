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

from mirage.core.discord.paginate import after_id_pages
from mirage.resource.discord.config import DiscordConfig


def list_guilds_stream(
    config: DiscordConfig,
    page_size: int = 200,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Page-streaming variant of list_guilds.

    Args:
        config (DiscordConfig): Discord credentials.
        page_size (int): per-page limit (Discord caps at 200).

    Yields:
        list[dict]: guild dicts per page.
    """
    return after_id_pages(
        config,
        "/users/@me/guilds",
        base_params={},
        last_id_fn=lambda g: g["id"],
        page_size=page_size,
    )


async def list_guilds(
    config: DiscordConfig,
    page_size: int = 200,
) -> list[dict[str, Any]]:
    """List all guilds the bot is in (paginated).

    Args:
        config (DiscordConfig): Discord credentials.
        page_size (int): per-page limit.

    Returns:
        list[dict]: guild dicts with id, name.
    """
    out: list[dict[str, Any]] = []
    async for page in list_guilds_stream(config, page_size):
        out.extend(page)
    return out
