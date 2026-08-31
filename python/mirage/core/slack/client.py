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
from functools import partial
from typing import Any

import aiohttp

from mirage.core.api.client import SessionArg, api_request
from mirage.core.slack.config import SlackConfig
from mirage.resource.secrets import reveal_secret


def _auth_token(config: SlackConfig, method: str) -> str:
    if method.startswith("search."):
        search_token: str = reveal_secret(config.search_token)
        if search_token:
            return search_token
    token: str = reveal_secret(config.token)
    return token


def slack_search_available(config: SlackConfig) -> bool:
    if reveal_secret(config.search_token):
        return True
    token: str = reveal_secret(config.token)
    return token.startswith("xoxp-")


def slack_headers(config: SlackConfig, method: str) -> dict[str, str]:
    auth_token = _auth_token(config, method)
    return {
        "Authorization": f"Bearer {auth_token}",
        "Content-Type": "application/json; charset=utf-8",
    }


def _format_slack_error(method: str, data: dict[str, Any]) -> str:
    err = data.get("error", "unknown_error")
    base = f"Slack API error ({method}): {err}"
    if err != "missing_scope":
        return base
    needed = data.get("needed") or ""
    if not needed:
        return base
    provided = data.get("provided") or "(none)"
    return f"{base} (needed: {needed}; provided: {provided})"


def _error_of(resp: aiohttp.ClientResponse, text: str, *,
              method: str) -> Exception:
    # Slack reports failures as ok:false payloads, usually with a 200; a
    # non-2xx that still carries one keeps Slack's own wording.
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if isinstance(data, dict):
        return RuntimeError(_format_slack_error(method, data))
    return RuntimeError(f"Slack API error ({method}): HTTP {resp.status}")


def _checked(method: str, data: Any) -> dict[str, Any]:
    payload = data if isinstance(data, dict) else {}
    if not payload.get("ok"):
        raise RuntimeError(_format_slack_error(method, payload))
    return payload


async def slack_get(config: SlackConfig,
                    method: str,
                    params: dict[str, Any] | None = None,
                    session: SessionArg = None) -> dict[str, Any]:
    url = f"{config.base_url.rstrip('/')}/{method}"
    data = await api_request("GET",
                             url,
                             error_of=partial(_error_of, method=method),
                             headers=slack_headers(config, method),
                             params=params,
                             session=session)
    return _checked(method, data)


async def slack_post(config: SlackConfig,
                     method: str,
                     body: dict[str, Any] | None = None,
                     session: SessionArg = None) -> dict[str, Any]:
    url = f"{config.base_url.rstrip('/')}/{method}"
    data = await api_request("POST",
                             url,
                             error_of=partial(_error_of, method=method),
                             headers=slack_headers(config, method),
                             json_body=body or {},
                             session=session)
    return _checked(method, data)
