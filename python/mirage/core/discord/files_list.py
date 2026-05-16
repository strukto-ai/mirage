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

from mirage.core.discord.history import stream_messages_for_day
from mirage.resource.discord.config import DiscordConfig


def _attach_meta(att: dict, msg: dict, date_str: str, channel_id: str) -> dict:
    """Attach context (date, channel_id, author, message_id) to an
    attachment so downstream readdir/read can hydrate without re-walking.
    """
    return {
        **att,
        "_date": date_str,
        "_channel_id": channel_id,
        "_message_id": msg.get("id", ""),
        "_author": msg.get("author", {}).get("username", "?"),
    }


async def list_files_for_day_stream(
    config: DiscordConfig,
    channel_id: str,
    date_str: str,
) -> AsyncIterator[list[dict]]:
    """Stream attachments for a channel-day.

    Discord has no dedicated files endpoint; attachments are embedded on
    each message. This walks the day's history and emits one batch of
    attachments per message-page.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.

    Yields:
        list[dict]: attachment dicts, augmented with ``_date``,
        ``_channel_id``, ``_message_id``, ``_author`` keys.
    """
    async for page in stream_messages_for_day(config, channel_id, date_str):
        atts: list[dict] = []
        for msg in page:
            for att in msg.get("attachments") or []:
                atts.append(_attach_meta(att, msg, date_str, channel_id))
        if atts:
            yield atts


async def list_files_for_day(
    config: DiscordConfig,
    channel_id: str,
    date_str: str,
) -> list[dict]:
    """List all attachments for a channel-day (eager).

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.

    Returns:
        list[dict]: attachments with embedded message context.
    """
    out: list[dict] = []
    async for page in list_files_for_day_stream(config, channel_id, date_str):
        out.extend(page)
    return out
