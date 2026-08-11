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

from mirage.core.discord._client import (discord_delete, discord_patch,
                                         discord_post)
from mirage.core.discord.config import DiscordConfig


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


async def edit_message(
    config: DiscordConfig,
    channel_id: str,
    message_id: str,
    text: str,
) -> dict[str, Any]:
    """Edit the content of a message the bot authored.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        message_id (str): message ID.
        text (str): new message content.

    Returns:
        dict: the updated message.
    """
    return await discord_patch(
        config,
        f"/channels/{channel_id}/messages/{message_id}",
        {"content": text},
    )


async def delete_message(
    config: DiscordConfig,
    channel_id: str,
    message_id: str,
) -> None:
    """Delete a message.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        message_id (str): message ID.
    """
    await discord_delete(
        config,
        f"/channels/{channel_id}/messages/{message_id}",
    )


async def send_poll(
    config: DiscordConfig,
    channel_id: str,
    question: str,
    answers: list[str],
    duration_hours: int = 24,
    multiselect: bool = False,
) -> dict[str, Any]:
    """Post a poll message to a channel.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        question (str): poll question text.
        answers (list[str]): answer option texts.
        duration_hours (int): poll lifetime in hours.
        multiselect (bool): allow selecting several answers.

    Returns:
        dict: the created poll message.
    """
    body: dict[str, Any] = {
        "poll": {
            "question": {
                "text": question
            },
            "answers": [{
                "poll_media": {
                    "text": answer
                }
            } for answer in answers],
            "duration": duration_hours,
            "allow_multiselect": multiselect,
        }
    }
    return await discord_post(
        config,
        f"/channels/{channel_id}/messages",
        body,
    )
