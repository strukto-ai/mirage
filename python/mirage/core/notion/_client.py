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

from collections.abc import Mapping
from typing import Any

import aiohttp

from mirage.core.notion.config import NotionConfig
from mirage.resource.secrets import reveal_secret

# 2025-09-03 is the generation that split databases into data sources: a
# database became a container of data sources and the column schema moved to
# the data source, so `/databases/{id}` no longer answers with `properties` and
# `/search` rejects `filter.value = "database"`.
API_VERSION = "2025-09-03"
MAX_PAGE_SIZE = 100


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


def notion_headers(config: NotionConfig,
                   extra: Mapping[str, str] | None = None) -> dict[str, str]:
    """The headers every request carries, plus a caller's own.

    Args:
        config (NotionConfig): notion API config.
        extra (Mapping[str, str] | None): per-request headers, which
            `ntn api` collects from its `Header:Value` inputs. Applied
            last so a caller can override a default, which is what the
            real CLI does.
    """
    headers = {
        "Authorization": f"Bearer {reveal_secret(config.api_key)}",
        "Notion-Version": config.api_version or API_VERSION,
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


async def notion_get(
    config: NotionConfig,
    path: str,
    params: dict[str, Any] | None = None,
    extra_headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    url = f"{config.base_url}{path}"
    headers = notion_headers(config, extra_headers)
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
    extra_headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    url = f"{config.base_url}{path}"
    headers = notion_headers(config, extra_headers)
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
    extra_headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    url = f"{config.base_url}{path}"
    headers = notion_headers(config, extra_headers)
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


async def notion_put(
    config: NotionConfig,
    path: str,
    body: dict[str, Any] | None = None,
    extra_headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    url = f"{config.base_url}{path}"
    headers = notion_headers(config, extra_headers)
    async with aiohttp.ClientSession() as session:
        async with session.put(url, headers=headers, json=body or {}) as resp:
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
    max_results: int | None = None,
) -> list[dict[str, Any]]:
    merged = dict(body or {})
    merged["page_size"] = min(page_size, MAX_PAGE_SIZE)
    results: list[dict[str, Any]] = []
    while True:
        data = await notion_post(config, path, merged)
        results.extend(data.get("results", []))
        if max_results is not None and len(results) >= max_results:
            return results[:max_results]
        if not data.get("has_more"):
            break
        merged["start_cursor"] = data["next_cursor"]
    return results
