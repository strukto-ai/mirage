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

from mirage.accessor.notion import NotionAccessor
from mirage.core.api.client import RetryPolicy, api_request
from mirage.core.api.errors import ApiError
from mirage.core.api.paginate import cursor_items
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.constants import API_VERSION, MAX_PAGE_SIZE
from mirage.types import JsonValue
from mirage.vfs.secrets import reveal_secret

_RATE_LIMIT_RETRY = RetryPolicy(
    statuses=frozenset({429, 529}), max_retries=3, max_backoff=float("inf")
)


class NotionAPIError(ApiError):
    """A Notion call that failed, with Notion's error ``code``."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message, status)
        self.code = code


def notion_headers(
    config: NotionConfig, extra: Mapping[str, str] | None = None
) -> dict[str, str]:
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
    return NotionAPIError(
        message, status=resp.status, code=payload.get("code")
    )


async def notion_get(
    accessor: NotionAccessor,
    path: str,
    params: dict[str, Any] | None = None,
    extra_headers: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "GET",
        f"{accessor.config.base_url}{path}",
        error_of=_error_of,
        retry=_RATE_LIMIT_RETRY,
        headers=notion_headers(accessor.config, extra_headers),
        params=params,
        session=accessor.pool,
    )
    return data


async def notion_post(
    accessor: NotionAccessor,
    path: str,
    body: JsonValue = None,
    extra_headers: Mapping[str, str] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # `body or {}` would rewrite an empty list or a zero into an object.
    # `ntn api` can be handed any JSON value and sends it verbatim, so only
    # a genuinely absent body becomes `{}`.
    data: dict[str, Any] = await api_request(
        "POST",
        f"{accessor.config.base_url}{path}",
        error_of=_error_of,
        retry=_RATE_LIMIT_RETRY,
        headers=notion_headers(accessor.config, extra_headers),
        params=params,
        json_body=body if body is not None else {},
        session=accessor.pool,
    )
    return data


async def notion_patch(
    accessor: NotionAccessor,
    path: str,
    body: JsonValue = None,
    extra_headers: Mapping[str, str] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "PATCH",
        f"{accessor.config.base_url}{path}",
        error_of=_error_of,
        retry=_RATE_LIMIT_RETRY,
        headers=notion_headers(accessor.config, extra_headers),
        params=params,
        json_body=body if body is not None else {},
        session=accessor.pool,
    )
    return data


async def notion_put(
    accessor: NotionAccessor,
    path: str,
    body: JsonValue = None,
    extra_headers: Mapping[str, str] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "PUT",
        f"{accessor.config.base_url}{path}",
        error_of=_error_of,
        retry=_RATE_LIMIT_RETRY,
        headers=notion_headers(accessor.config, extra_headers),
        params=params,
        json_body=body if body is not None else {},
        session=accessor.pool,
    )
    return data


# DELETE carries no body at all, which is why it does not send one: the only
# route the public API exposes it on is /v1/blocks/{id}, whose whole payload is
# the id in the path.
async def notion_delete(
    accessor: NotionAccessor,
    path: str,
    body: JsonValue = None,
    extra_headers: Mapping[str, str] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "DELETE",
        f"{accessor.config.base_url}{path}",
        error_of=_error_of,
        retry=_RATE_LIMIT_RETRY,
        headers=notion_headers(accessor.config, extra_headers),
        params=params,
        session=accessor.pool,
    )
    return data


async def _list_page(
    accessor: NotionAccessor,
    path: str,
    params: dict[str, Any],
    cursor: str | None,
) -> dict[str, Any]:
    merged = dict(params)
    if cursor is not None:
        merged["start_cursor"] = cursor
    return await notion_get(accessor, path, params=merged)


async def paginate_list(
    accessor: NotionAccessor,
    path: str,
    params: dict[str, Any] | None = None,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    merged = dict(params or {})
    merged["page_size"] = page_size
    return await cursor_items(partial(_list_page, accessor, path, merged))


def complete_page(page: dict[str, Any]) -> dict[str, Any]:
    """Refuse a list response Notion marked incomplete.

    Args:
        page (dict[str, Any]): one list response.

    Returns:
        dict[str, Any]: the same response, when it is complete.

    Raises:
        NotionAPIError: when ``request_status`` says the rows stop short.
    """
    status = page.get("request_status")
    if isinstance(status, dict) and status.get("type") == "incomplete":
        reason = status.get("incomplete_reason", "unknown")
        raise NotionAPIError(f"Notion query incomplete: {reason}", code=reason)
    return page


async def _post_page(
    accessor: NotionAccessor,
    path: str,
    body: dict[str, Any],
    cursor: str | None,
) -> dict[str, Any]:
    merged = dict(body)
    if cursor is not None:
        merged["start_cursor"] = cursor
    return complete_page(await notion_post(accessor, path, merged))


async def paginate_post(
    accessor: NotionAccessor,
    path: str,
    body: dict[str, Any] | None = None,
    page_size: int = 100,
    max_results: int | None = None,
) -> list[dict[str, Any]]:
    merged = dict(body or {})
    merged["page_size"] = min(page_size, MAX_PAGE_SIZE)
    return await cursor_items(
        partial(_post_page, accessor, path, merged), max_results
    )
