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
from collections.abc import Mapping
from functools import partial
from typing import Any

import aiohttp

from mirage.core.api.client import SessionArg, api_request
from mirage.core.api.paginate import cursor_items
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.constants import API_VERSION, MAX_PAGE_SIZE
from mirage.resource.secrets import reveal_secret
from mirage.types import JsonValue


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


def _error_of(resp: aiohttp.ClientResponse, body: str) -> Exception:
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    payload = data if isinstance(data, dict) else {}
    message = payload.get("message") or f"Notion API error: HTTP {resp.status}"
    return NotionAPIError(message,
                          status=resp.status,
                          code=payload.get("code"))


async def notion_get(config: NotionConfig,
                     path: str,
                     params: dict[str, Any] | None = None,
                     extra_headers: Mapping[str, str] | None = None,
                     session: SessionArg = None) -> dict[str, Any]:
    data: dict[str, Any] = await api_request("GET",
                                             f"{config.base_url}{path}",
                                             error_of=_error_of,
                                             headers=notion_headers(
                                                 config, extra_headers),
                                             params=params,
                                             session=session)
    return data


async def notion_post(config: NotionConfig,
                      path: str,
                      body: JsonValue = None,
                      extra_headers: Mapping[str, str] | None = None,
                      params: dict[str, Any] | None = None,
                      session: SessionArg = None) -> dict[str, Any]:
    # `body or {}` would rewrite an empty list or a zero into an object.
    # `ntn api` can be handed any JSON value and sends it verbatim, so only
    # a genuinely absent body becomes `{}`.
    data: dict[str, Any] = await api_request(
        "POST",
        f"{config.base_url}{path}",
        error_of=_error_of,
        headers=notion_headers(config, extra_headers),
        params=params,
        json_body=body if body is not None else {},
        session=session)
    return data


async def notion_patch(config: NotionConfig,
                       path: str,
                       body: JsonValue = None,
                       extra_headers: Mapping[str, str] | None = None,
                       params: dict[str, Any] | None = None,
                       session: SessionArg = None) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "PATCH",
        f"{config.base_url}{path}",
        error_of=_error_of,
        headers=notion_headers(config, extra_headers),
        params=params,
        json_body=body if body is not None else {},
        session=session)
    return data


async def notion_put(config: NotionConfig,
                     path: str,
                     body: JsonValue = None,
                     extra_headers: Mapping[str, str] | None = None,
                     params: dict[str, Any] | None = None,
                     session: SessionArg = None) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "PUT",
        f"{config.base_url}{path}",
        error_of=_error_of,
        headers=notion_headers(config, extra_headers),
        params=params,
        json_body=body if body is not None else {},
        session=session)
    return data


# DELETE carries no body at all, which is why it does not send one: the only
# route the public API exposes it on is /v1/blocks/{id}, whose whole payload is
# the id in the path.
async def notion_delete(config: NotionConfig,
                        path: str,
                        body: JsonValue = None,
                        extra_headers: Mapping[str, str] | None = None,
                        params: dict[str, Any] | None = None,
                        session: SessionArg = None) -> dict[str, Any]:
    data: dict[str, Any] = await api_request("DELETE",
                                             f"{config.base_url}{path}",
                                             error_of=_error_of,
                                             headers=notion_headers(
                                                 config, extra_headers),
                                             params=params,
                                             session=session)
    return data


async def _list_page(config: NotionConfig,
                     path: str,
                     params: dict[str, Any],
                     cursor: str | None,
                     session: SessionArg = None) -> dict[str, Any]:
    merged = dict(params)
    if cursor is not None:
        merged["start_cursor"] = cursor
    return await notion_get(config, path, params=merged, session=session)


async def paginate_list(
    config: NotionConfig,
    path: str,
    params: dict[str, Any] | None = None,
    page_size: int = 100,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    merged = dict(params or {})
    merged["page_size"] = page_size
    return await cursor_items(
        partial(_list_page, config, path, merged, session=session))


async def _post_page(config: NotionConfig,
                     path: str,
                     body: dict[str, Any],
                     cursor: str | None,
                     session: SessionArg = None) -> dict[str, Any]:
    merged = dict(body)
    if cursor is not None:
        merged["start_cursor"] = cursor
    return await notion_post(config, path, merged, session=session)


async def paginate_post(
    config: NotionConfig,
    path: str,
    body: dict[str, Any] | None = None,
    page_size: int = 100,
    max_results: int | None = None,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    merged = dict(body or {})
    merged["page_size"] = min(page_size, MAX_PAGE_SIZE)
    return await cursor_items(
        partial(_post_page, config, path, merged, session=session),
        max_results)
