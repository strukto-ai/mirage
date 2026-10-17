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

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.client import discord_post


async def create_thread(
    accessor: DiscordAccessor,
    channel_id: str,
    name: str,
    message_id: str | None = None,
) -> dict[str, Any]:
    """Create a thread, either from a message or standalone.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): parent channel ID.
        name (str): thread name.
        message_id (str | None): start the thread from this message.

    Returns:
        dict: the created thread channel.
    """
    if message_id:
        return await discord_post(
            accessor,
            f"/channels/{channel_id}/messages/{message_id}/threads",
            {"name": name},
        )
    # Standalone threads must state a type: the API otherwise defaults
    # to PRIVATE_THREAD, which needs extra permissions. 11 = PUBLIC_THREAD.
    return await discord_post(
        accessor, f"/channels/{channel_id}/threads", {"name": name, "type": 11}
    )
