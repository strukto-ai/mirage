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
from mirage.resource.discord.config import DiscordConfig

TEXT_CHANNEL_TYPES = (0, 5, 15)


async def list_channels_stream(
    config: DiscordConfig,
    guild_id: str,
) -> AsyncIterator[list[dict[str, Any]]]:
    """List text channels in a guild as a single-page stream.

    Discord returns all guild channels in one response (no pagination
    cursor); the stream interface is provided for API parity with other
    fetchers.

    Args:
        config (DiscordConfig): Discord credentials.
        guild_id (str): guild ID.

    Yields:
        list[dict]: filtered text-channel dicts.
    """
    raw = await discord_get(config, f"/guilds/{guild_id}/channels")
    if not isinstance(raw, list):
        return
    yield [c for c in raw if c.get("type") in TEXT_CHANNEL_TYPES]


async def list_channels(
    config: DiscordConfig,
    guild_id: str,
) -> list[dict[str, Any]]:
    """List text channels in a guild.

    Args:
        config (DiscordConfig): Discord credentials.
        guild_id (str): guild ID.

    Returns:
        list[dict]: channel dicts (text channels only).
    """
    out: list[dict[str, Any]] = []
    async for page in list_channels_stream(config, guild_id):
        out.extend(page)
    return out
