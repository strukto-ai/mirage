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
from typing import Any

from mirage.core.slack._client import slack_get
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.paginate import cursor_pages


def _is_real_user(m: dict[str, Any]) -> bool:
    return (not m.get("deleted") and not m.get("is_bot")
            and m.get("id") != "USLACKBOT")


async def list_users_stream(
    config: SlackConfig,
    limit: int = 200,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Page-streaming user list; yields filtered humans per page.

    Args:
        config (SlackConfig): Slack credentials.
        limit (int): max per page.

    Yields:
        list[dict]: real users in one Slack page (bots, deleted, and
        slackbot are filtered out before yielding).
    """
    async for page in cursor_pages(
            config,
            "users.list",
            base_params={"limit": limit},
            items_key="members",
    ):
        yield [m for m in page if _is_real_user(m)]


async def list_users(
    config: SlackConfig,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """List workspace users (eager; collects all pages).

    Args:
        config (SlackConfig): Slack credentials.
        limit (int): max per page.

    Returns:
        list[dict]: user dicts.
    """
    out: list[dict[str, Any]] = []
    async for page in list_users_stream(config, limit=limit):
        out.extend(page)
    return out


def user_json_bytes(user: dict[str, Any]) -> bytes:
    """Render one user object as its .json byte content.

    The single renderer behind both read and the readdir-time size.
    readdir sizes a user from the users.list member; read renders the
    users.info response. Sizing is exact only while those two payloads
    encode identically, which was verified live on 2026-08-01: every real
    user in a live workspace matched byte for byte, key order included.

    The integ battery cannot catch a regression here. The fake server
    builds users.list and users.info from one row through one helper, so
    they agree by construction; only a live call tests the assumption.

    Args:
        user (dict): user object from users.list or users.info.

    Returns:
        bytes: compact JSON encoding.
    """
    return json.dumps(user, ensure_ascii=False, separators=(",", ":")).encode()


async def get_user_profile(
    config: SlackConfig,
    user_id: str,
) -> dict[str, Any]:
    """Get a single user's profile.

    Args:
        config (SlackConfig): Slack credentials.
        user_id (str): user ID.

    Returns:
        dict: user info.
    """
    data = await slack_get(config, "users.info", params={"user": user_id})
    return data.get("user", {})


async def search_users(
    config: SlackConfig,
    query: str,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Search users by name, real name, or email.

    Args:
        config (SlackConfig): Slack credentials.
        query (str): search query.
        limit (int): max per page.

    Returns:
        list[dict]: matching users.
    """
    all_users = await list_users(config, limit=limit)
    q = query.lower()
    return [
        u for u in all_users
        if q in u.get("name", "").lower() or q in u.get("real_name", "").lower(
        ) or q in u.get("profile", {}).get("email", "").lower()
    ]
