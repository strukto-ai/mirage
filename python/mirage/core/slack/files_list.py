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
from datetime import datetime, timezone

from mirage.core.slack.paginate import offset_pages
from mirage.resource.slack.config import SlackConfig


def _day_range_ts(date_str: str) -> tuple[str, str]:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    ts_from = str(dt.timestamp())
    ts_to = str(dt.replace(hour=23, minute=59, second=59).timestamp())
    return ts_from, ts_to


def list_files_for_day_stream(
    config: SlackConfig,
    channel_id: str,
    date_str: str,
    count: int = 200,
) -> AsyncIterator[list[dict]]:
    """Page-streaming variant of list_files_for_day.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.
        count (int): per-page count (Slack caps at 200).

    Yields:
        list[dict]: file metadata dicts in one Slack page.
    """
    ts_from, ts_to = _day_range_ts(date_str)
    return offset_pages(
        config,
        "files.list",
        base_params={
            "channel": channel_id,
            "ts_from": ts_from,
            "ts_to": ts_to,
            "count": str(count),
        },
        pages_path=("paging", "pages"),
        items_path=("files", ),
    )


async def list_files_for_day(
    config: SlackConfig,
    channel_id: str,
    date_str: str,
    count: int = 200,
) -> list[dict]:
    """List files attached to a channel on a given UTC date (eager).

    Uses files.list filtered by channel + date bounds. Much cheaper
    than walking conversations.history just to extract msg.files[].

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.
        count (int): per-page count.

    Returns:
        list[dict]: all files attached in that channel-day.
    """
    out: list[dict] = []
    async for page in list_files_for_day_stream(config, channel_id, date_str,
                                                count):
        out.extend(page)
    return out
