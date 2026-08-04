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

from mirage.core.slack._client import slack_get, slack_post
from mirage.core.slack.config import SlackConfig


async def add_reaction(
    config: SlackConfig,
    channel_id: str,
    timestamp: str,
    reaction: str,
) -> dict[str, Any]:
    """Add a reaction to a message.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        timestamp (str): message ts.
        reaction (str): emoji name (without colons).

    Returns:
        dict: API response.
    """
    return await slack_post(config, "reactions.add", {
        "channel": channel_id,
        "timestamp": timestamp,
        "name": reaction,
    })


async def get_reactions(
    config: SlackConfig,
    channel_id: str,
    timestamp: str,
) -> dict[str, Any]:
    """Get the reactions on a message.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        timestamp (str): message ts.

    Returns:
        dict: the message item with its reactions array.
    """
    data = await slack_get(config, "reactions.get", {
        "channel": channel_id,
        "timestamp": timestamp,
    })
    message = data.get("message")
    return message if isinstance(message, dict) else {}
