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

from urllib.parse import quote

from mirage.core.discord._client import discord_put
from mirage.core.discord.config import DiscordConfig


async def add_reaction(
    config: DiscordConfig,
    channel_id: str,
    message_id: str,
    emoji: str,
) -> None:
    """Add a reaction to a message.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        message_id (str): message ID.
        emoji (str): emoji name or unicode.
    """
    encoded = quote(emoji, safe="")
    await discord_put(
        config,
        f"/channels/{channel_id}/messages"
        f"/{message_id}/reactions/{encoded}/@me",
    )
