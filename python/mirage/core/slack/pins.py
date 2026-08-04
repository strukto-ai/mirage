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


async def pin_message(
    config: SlackConfig,
    channel_id: str,
    timestamp: str,
) -> dict[str, Any]:
    """Pin a message to its channel.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        timestamp (str): message ts.

    Returns:
        dict: API response.
    """
    return await slack_post(config, "pins.add", {
        "channel": channel_id,
        "timestamp": timestamp,
    })


async def unpin_message(
    config: SlackConfig,
    channel_id: str,
    timestamp: str,
) -> dict[str, Any]:
    """Remove a pin from a message.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        timestamp (str): message ts.

    Returns:
        dict: API response.
    """
    return await slack_post(config, "pins.remove", {
        "channel": channel_id,
        "timestamp": timestamp,
    })


async def list_pins(
    config: SlackConfig,
    channel_id: str,
) -> list[dict[str, Any]]:
    """List the pinned items of a channel.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.

    Returns:
        list[dict]: pinned items as the API reports them.
    """
    data = await slack_get(config, "pins.list", {"channel": channel_id})
    items = data.get("items")
    return items if isinstance(items, list) else []
