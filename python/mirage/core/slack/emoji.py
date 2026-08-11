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

from mirage.core.slack._client import slack_get
from mirage.core.slack.config import SlackConfig


async def list_emoji(config: SlackConfig) -> dict[str, Any]:
    """List the workspace's custom emoji.

    Args:
        config (SlackConfig): Slack credentials.

    Returns:
        dict: emoji name to image URL (or alias:<name>) mapping.
    """
    data = await slack_get(config, "emoji.list")
    emoji = data.get("emoji")
    return emoji if isinstance(emoji, dict) else {}
