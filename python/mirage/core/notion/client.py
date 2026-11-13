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
from typing import Any

import aiohttp

from mirage.accessor.notion import NotionAccessor
from mirage.core.api.client import RetryPolicy, api_request
from mirage.core.api.errors import ApiError
from mirage.core.api.paginate import cursor_items
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


async def notion_request(
    accessor: NotionAccessor,
    method: str,
    path: str,
    body: JsonValue = None,
    extra_headers: Mapping[str, str] | None = None,
    params: dict[str, Any] | None = None,
    form: aiohttp.FormData | None = None,
) -> dict[str, Any]:
    """One Notion call: every verb and ``ntn api`` send through it.

    GET and DELETE carry no body; the only route DELETE exists on is
    /v1/blocks/{id}, whose whole payload is the id in the path. `body or
    {}` would rewrite an empty list or a zero into an object, and `ntn
    api` can be handed any JSON value and sends it verbatim, so only a
    genuinely absent body becomes `{}`. A multipart body replaces the JSON
    one, and its boundary sets its own content type.

    Args:
        accessor (NotionAccessor): the account's config and pool.
        method (str): the HTTP method.
        path (str): the API path under the base URL.
        body (JsonValue): the JSON body; GET and DELETE send none.
        extra_headers (Mapping[str, str] | None): per-request headers,
            which `ntn api` collects from its `Header:Value` inputs,
            applied last so a caller can override a default, as the real
            CLI does.
        params (dict[str, Any] | None): query parameters.
        form (aiohttp.FormData | None): a multipart body sent in place of
            the JSON one.
    """
    headers = {
        "Authorization": f"Bearer {reveal_secret(accessor.config.api_key)}",
        "Notion-Version": accessor.config.api_version or API_VERSION,
        "Content-Type": "application/json",
        **(extra_headers or {}),
    }
    json_body: JsonValue = None
    if form is not None:
        del headers["Content-Type"]
    elif method not in ("GET", "DELETE"):
        json_body = body if body is not None else {}
    data: dict[str, Any] = await api_request(
        method,
        f"{accessor.config.base_url}{path}",
        error_of=_error_of,
        retry=_RATE_LIMIT_RETRY,
        headers=headers,
        params=params,
        json_body=json_body,
        data=form,
        session=accessor.pool,
    )
    return data


async def paginate_list(
    accessor: NotionAccessor,
    path: str,
    params: dict[str, Any] | None = None,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    merged = {**(params or {}), "page_size": page_size}

    async def page(cursor: str | None) -> dict[str, Any]:
        args = dict(merged)
        if cursor is not None:
            args["start_cursor"] = cursor
        return await notion_request(accessor, "GET", path, params=args)

    return await cursor_items(page)


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


async def paginate_post(
    accessor: NotionAccessor,
    path: str,
    body: dict[str, Any] | None = None,
    page_size: int = 100,
    max_results: int | None = None,
) -> list[dict[str, Any]]:
    merged = {**(body or {}), "page_size": min(page_size, MAX_PAGE_SIZE)}

    async def page(cursor: str | None) -> dict[str, Any]:
        args = dict(merged)
        if cursor is not None:
            args["start_cursor"] = cursor
        return complete_page(
            await notion_request(accessor, "POST", path, args)
        )

    return await cursor_items(page, max_results)
