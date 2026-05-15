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
from collections.abc import AsyncIterator

from mirage.core.slack._client import slack_get
from mirage.core.slack.paginate import offset_pages
from mirage.resource.slack.config import SlackConfig


def search_available(config: SlackConfig) -> bool:
    if config.search_token:
        return True
    return config.token.startswith("xoxp-")


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
        token=config.search_token,
    )
    return json.dumps(data, ensure_ascii=False).encode()


def search_messages_stream(
    config: SlackConfig,
    query: str,
    count: int = 100,
    start_page: int = 1,
    max_pages: int | None = None,
) -> AsyncIterator[list[dict]]:
    """Page-streaming search.messages; yields match lists per Slack page.

    Args:
        config (SlackConfig): Slack credentials.
        query (str): search query.
        count (int): results per page (Slack caps at 100).
        start_page (int): 1-based starting page.
        max_pages (int | None): cap on pages walked; None = unbounded.

    Yields:
        list[dict]: matches in one Slack page.
    """
    return offset_pages(
        config,
        "search.messages",
        base_params={
            "query": query,
            "count": str(count),
            "sort": "timestamp",
        },
        pages_path=("messages", "pagination", "page_count"),
        items_path=("messages", "matches"),
        start_page=start_page,
        max_pages=max_pages,
        token=config.search_token,
    )


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
        token=config.search_token,
    )
    return json.dumps(data, ensure_ascii=False).encode()


def search_files_stream(
    config: SlackConfig,
    query: str,
    count: int = 100,
    start_page: int = 1,
    max_pages: int | None = None,
) -> AsyncIterator[list[dict]]:
    """Page-streaming search.files; yields file lists per Slack page.

    Args:
        config (SlackConfig): Slack credentials.
        query (str): search query.
        count (int): results per page (Slack caps at 100).
        start_page (int): 1-based starting page.
        max_pages (int | None): cap on pages walked; None = unbounded.

    Yields:
        list[dict]: file matches in one Slack page.
    """
    return offset_pages(
        config,
        "search.files",
        base_params={
            "query": query,
            "count": str(count),
            "sort": "timestamp",
        },
        pages_path=("files", "pagination", "page_count"),
        items_path=("files", "matches"),
        start_page=start_page,
        max_pages=max_pages,
        token=config.search_token,
    )
