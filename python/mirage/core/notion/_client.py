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

import aiohttp

from mirage.resource.notion.config import NotionConfig
from mirage.resource.secrets import reveal_secret

API_VERSION = "2022-06-28"


class NotionAPIError(RuntimeError):

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def notion_headers(config: NotionConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {reveal_secret(config.api_key)}",
        "Notion-Version": API_VERSION,
        "Content-Type": "application/json",
    }


async def notion_get(
    config: NotionConfig,
    path: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{config.base_url}{path}"
    headers = notion_headers(config)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, params=params) as resp:
            data = await resp.json()
            if resp.status >= 400:
                message = data.get(
                    "message") or f"Notion API error: HTTP {resp.status}"
                raise NotionAPIError(
                    message,
                    status=resp.status,
                    code=data.get("code"),
                )
            return data


async def notion_post(
    config: NotionConfig,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{config.base_url}{path}"
    headers = notion_headers(config)
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=body or {}) as resp:
            data = await resp.json()
            if resp.status >= 400:
                message = data.get(
                    "message") or f"Notion API error: HTTP {resp.status}"
                raise NotionAPIError(
                    message,
                    status=resp.status,
                    code=data.get("code"),
                )
            return data


async def notion_patch(
    config: NotionConfig,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{config.base_url}{path}"
    headers = notion_headers(config)
    async with aiohttp.ClientSession() as session:
        async with session.patch(url, headers=headers, json=body
                                 or {}) as resp:
            data = await resp.json()
            if resp.status >= 400:
                message = data.get(
                    "message") or f"Notion API error: HTTP {resp.status}"
                raise NotionAPIError(
                    message,
                    status=resp.status,
                    code=data.get("code"),
                )
            return data


async def paginate_list(
    config: NotionConfig,
    path: str,
    params: dict[str, Any] | None = None,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    merged = dict(params or {})
    merged["page_size"] = page_size
    results: list[dict[str, Any]] = []
    while True:
        data = await notion_get(config, path, params=merged)
        results.extend(data.get("results", []))
        if not data.get("has_more"):
            break
        merged["start_cursor"] = data["next_cursor"]
    return results


async def paginate_post(
    config: NotionConfig,
    path: str,
    body: dict[str, Any] | None = None,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    merged = dict(body or {})
    merged["page_size"] = page_size
    results: list[dict[str, Any]] = []
    while True:
        data = await notion_post(config, path, merged)
        results.extend(data.get("results", []))
        if not data.get("has_more"):
            break
        merged["start_cursor"] = data["next_cursor"]
    return results
