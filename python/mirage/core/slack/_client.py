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

import aiohttp

from mirage.resource.secrets import reveal_secret
from mirage.resource.slack.config import SlackConfig

SLACK_API = "https://slack.com/api"


def _auth_token(config: SlackConfig, method: str) -> str:
    if method.startswith("search."):
        search_token = reveal_secret(config.search_token)
        if search_token:
            return search_token
    return reveal_secret(config.token)


def slack_search_available(config: SlackConfig) -> bool:
    if reveal_secret(config.search_token):
        return True
    token = reveal_secret(config.token)
    return token.startswith("xoxp-")


def slack_headers(config: SlackConfig, method: str) -> dict[str, str]:
    auth_token = _auth_token(config, method)
    return {
        "Authorization": f"Bearer {auth_token}",
        "Content-Type": "application/json; charset=utf-8",
    }


def _format_slack_error(method: str, data: dict) -> str:
    err = data.get("error", "unknown_error")
    base = f"Slack API error ({method}): {err}"
    if err != "missing_scope":
        return base
    needed = data.get("needed") or ""
    if not needed:
        return base
    provided = data.get("provided") or "(none)"
    return f"{base} (needed: {needed}; provided: {provided})"


async def slack_get(
    config: SlackConfig,
    method: str,
    params: dict | None = None,
) -> dict:
    url = f"{SLACK_API}/{method}"
    headers = slack_headers(config, method)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, params=params) as resp:
            data = await resp.json()
            if not data.get("ok"):
                raise RuntimeError(_format_slack_error(method, data))
            return data


async def slack_post(
    config: SlackConfig,
    method: str,
    body: dict | None = None,
) -> dict:
    url = f"{SLACK_API}/{method}"
    headers = slack_headers(config, method)
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=body or {}) as resp:
            data = await resp.json()
            if not data.get("ok"):
                raise RuntimeError(_format_slack_error(method, data))
            return data
