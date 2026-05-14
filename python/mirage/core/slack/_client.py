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

from mirage.resource.slack.config import SlackConfig

SLACK_API = "https://slack.com/api"


def slack_headers(config: SlackConfig,
                  token: str | None = None) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token or config.token}",
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
    token: str | None = None,
) -> dict:
    url = f"{SLACK_API}/{method}"
    headers = slack_headers(config, token=token)
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
    headers = slack_headers(config)
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=body or {}) as resp:
            data = await resp.json()
            if not data.get("ok"):
                raise RuntimeError(_format_slack_error(method, data))
            return data
