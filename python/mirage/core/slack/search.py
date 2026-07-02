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

import json

from mirage.core.slack._client import slack_get, slack_search_available
from mirage.resource.slack.config import SlackConfig


def search_available(config: SlackConfig) -> bool:
    return slack_search_available(config)


async def search_messages(
    config: SlackConfig,
    query: str,
    count: int = 20,
    page: int = 1,
) -> bytes:
    """Search messages across workspace (single page).

    Args:
        config (SlackConfig): Slack credentials.
        query (str): search query.
        count (int): results per page (Slack caps at 100).
        page (int): 1-based page number.

    Returns:
        bytes: JSON response.
    """
    params = {
        "query": query,
        "count": count,
        "page": page,
        "sort": "timestamp",
    }
    data = await slack_get(
        config,
        "search.messages",
        params=params,
    )
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()


async def search_files(
    config: SlackConfig,
    query: str,
    count: int = 20,
    page: int = 1,
) -> bytes:
    """Search files across workspace via search.files (single page).

    Args:
        config (SlackConfig): Slack credentials.
        query (str): search query.
        count (int): results per page (Slack caps at 100).
        page (int): 1-based page number.

    Returns:
        bytes: JSON response.
    """
    params = {
        "query": query,
        "count": count,
        "page": page,
        "sort": "timestamp",
    }
    data = await slack_get(
        config,
        "search.files",
        params=params,
    )
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
