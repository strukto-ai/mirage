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

from mirage.core.api.client import SessionArg
from mirage.core.slack.client import slack_post
from mirage.core.slack.config import SlackConfig


async def post_message(config: SlackConfig,
                       channel_id: str,
                       text: str,
                       session: SessionArg = None) -> dict[str, Any]:
    """Post a message to a channel.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        text (str): message text.
        session (SessionArg): pool or live session to ride.

    Returns:
        dict: API response.
    """
    return await slack_post(config,
                            "chat.postMessage", {
                                "channel": channel_id,
                                "text": text,
                            },
                            session=session)


async def reply_to_thread(config: SlackConfig,
                          channel_id: str,
                          thread_ts: str,
                          text: str,
                          session: SessionArg = None) -> dict[str, Any]:
    """Reply to a thread.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        thread_ts (str): parent message ts.
        text (str): reply text.
        session (SessionArg): pool or live session to ride.

    Returns:
        dict: API response.
    """
    return await slack_post(config,
                            "chat.postMessage", {
                                "channel": channel_id,
                                "thread_ts": thread_ts,
                                "text": text,
                            },
                            session=session)
