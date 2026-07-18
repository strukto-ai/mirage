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

from mirage.core.discord._client import discord_post
from mirage.resource.discord.config import DiscordConfig


async def send_message(
    config: DiscordConfig,
    channel_id: str,
    text: str,
    message_reference_id: str | None = None,
) -> dict[str, Any]:
    """Send a message to a channel.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        text (str): message content.
        message_reference_id (str | None): reply to message.

    Returns:
        dict: API response.
    """
    body: dict[str, Any] = {"content": text}
    if message_reference_id:
        body["message_reference"] = {"message_id": message_reference_id}
    return await discord_post(
        config,
        f"/channels/{channel_id}/messages",
        body,
    )
