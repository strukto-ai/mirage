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

from typing import Any, cast

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.client import discord_request

PIN_PAGE_SIZE = 50


async def pin_message(
    accessor: DiscordAccessor, channel_id: str, message_id: str
) -> None:
    """Pin a message to its channel.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
        message_id (str): message ID.
    """
    await discord_request(
        accessor, "PUT", f"/channels/{channel_id}/messages/pins/{message_id}"
    )


async def unpin_message(
    accessor: DiscordAccessor, channel_id: str, message_id: str
) -> None:
    """Remove a pin from a message.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
        message_id (str): message ID.
    """
    await discord_request(
        accessor,
        "DELETE",
        f"/channels/{channel_id}/messages/pins/{message_id}",
    )


async def list_pins(
    accessor: DiscordAccessor, channel_id: str
) -> list[dict[str, Any]]:
    """Every pin of a channel, most recently pinned first.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
    """
    params: dict[str, Any] = {"limit": PIN_PAGE_SIZE}
    pins: list[dict[str, Any]] = []
    while True:
        page = cast(
            dict[str, Any],
            await discord_request(
                accessor,
                "GET",
                f"/channels/{channel_id}/messages/pins",
                params,
            ),
        )
        items = page.get("items", [])
        pins.extend(items)
        if not page.get("has_more") or not items:
            return pins
        params = {**params, "before": items[-1]["pinned_at"]}
