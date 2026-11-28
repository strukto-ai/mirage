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

# Request headers and error messages follow @tavily/core 1.1.0's
# transport, which tvly 1.0.2 sends through (MIT; see
# licenses/third_party/tavily-cli.txt).

import asyncio
import errno
import json
from typing import Any

import aiohttp
import orjson

from mirage.accessor.tavily import TavilyAccessor
from mirage.core.api.client import ReadMode, api_request
from mirage.core.api.errors import ApiError
from mirage.core.render.json import ecma_numbers, number_text
from mirage.core.tavily.constants import CLIENT_SOURCE, KEYLESS_CLIENT_SOURCE
from mirage.types import JsonValue
from mirage.vfs.secrets import reveal_secret


class TavilyAPIError(ApiError):
    """A call the Tavily API refused.

    Args:
        message (str): the message the API's body carries.
        status (int): the HTTP status.
    """


class TavilyKeylessLimit(TavilyAPIError):
    """The keyless fair-use cap, with the envelope the API sends for it.

    Args:
        message (str): the envelope's message, or its code.
        status (int): the HTTP status.
        error (dict[str, JsonValue]): the envelope's ``error`` object.
    """

    def __init__(
        self, message: str, status: int, error: dict[str, JsonValue]
    ) -> None:
        super().__init__(message, status)
        self.error = error


class TavilyUnanswered(Exception):
    """A call Tavily never answered: it timed out or did not connect.

    Args:
        message (str): the SDK's wording for what happened.
    """


def compact_json(value: JsonValue) -> str:
    """``JSON.stringify(value)``: compact, numbers spelled as TypeScript does.

    Args:
        value (JsonValue): a decoded JSON value.
    """
    return orjson.dumps(ecma_numbers(value)).decode()


def _error_of(resp: aiohttp.ClientResponse, text: str) -> Exception:
    try:
        body: Any = json.loads(text)
    except ValueError:
        body = text
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and isinstance(error.get("code"), str):
        if isinstance(error.get("next_actions"), list):
            message = error.get("message")
            return TavilyKeylessLimit(
                message if isinstance(message, str) else error["code"],
                resp.status,
                error,
            )
    detail = body.get("detail") if isinstance(body, dict) else None
    message = detail.get("error") if isinstance(detail, dict) else None
    if message is None and isinstance(error, dict):
        message = error.get("message")
    if not isinstance(message, str) or not message:
        message = f"{resp.status} Error: {compact_json(body)}"
    return TavilyAPIError(message, resp.status)


def _unanswered_text(exc: aiohttp.ClientError) -> str:
    """The failure as tvly prints it: Node's socket error for a connection
    that never opened (``connect ECONNREFUSED``, ``getaddrinfo
    ENOTFOUND``), else the client's own message.

    Args:
        exc (aiohttp.ClientError): what the call raised.
    """
    if isinstance(exc, aiohttp.ClientConnectorDNSError):
        return f"Error: getaddrinfo ENOTFOUND {exc.host}"
    if isinstance(exc, aiohttp.ClientConnectorError):
        code = errno.errorcode.get(exc.os_error.errno or 0)
        if code is not None:
            return f"Error: connect {code} {exc.host}:{exc.port}"
    return str(exc)


def _headers(
    accessor: TavilyAccessor, client_name: str | None
) -> dict[str, str]:
    key = reveal_secret(accessor.config.api_key)
    headers = {
        "Content-Type": "application/json",
        "X-Client-Source": CLIENT_SOURCE if key else KEYLESS_CLIENT_SOURCE,
    }
    if key:
        headers["Authorization"] = f"Bearer {key}"
    else:
        headers["X-Tavily-Access-Mode"] = "keyless"
    if client_name:
        headers["X-Client-Name"] = client_name
    return headers


def timed_body(
    body: dict[str, JsonValue], default: float
) -> tuple[dict[str, JsonValue], float]:
    """The body with its ``timeout`` filled, and how long the call may take.

    A number the line gave is both the API's budget and the call's;
    without one the verb's default is both, so the body always says it.

    Args:
        body (dict[str, JsonValue]): the request body.
        default (float): the verb's default, in seconds.
    """
    given = body.get("timeout")
    if isinstance(given, (int, float)) and not isinstance(given, bool):
        return body, float(given)
    filled = int(default) if default == int(default) else default
    return {**body, "timeout": filled}, default


async def tavily_request(
    accessor: TavilyAccessor,
    method: str,
    endpoint: str,
    body: JsonValue = None,
    *,
    timeout: float | None = None,
    client_name: str | None = None,
    read: ReadMode = "json",
) -> Any:
    """One Tavily call; every tvly verb sends through it.

    Args:
        accessor (TavilyAccessor): the account's config and pool.
        method (str): the HTTP method.
        endpoint (str): the path under the API root, without a slash.
        body (JsonValue): the JSON body; a GET sends none.
        timeout (float | None): seconds the whole call may take; None
            waits as long as the answer keeps flowing.
        client_name (str | None): sent as ``X-Client-Name``.
        read (ReadMode): "json" for an answer, "text" for a stream read
            whole.

    Raises:
        TavilyAPIError: the API refused the call.
        TavilyUnanswered: it took longer than ``timeout`` or never
            connected.
    """
    try:
        async with asyncio.timeout(timeout):
            return await api_request(
                method,
                f"{accessor.config.base_url.rstrip('/')}/{endpoint}",
                error_of=_error_of,
                headers=_headers(accessor, client_name),
                json_body=body if method != "GET" else None,
                read=read,
                session=accessor.pool,
            )
    except TimeoutError as exc:
        seconds = number_text(timeout) if timeout is not None else "0"
        raise TavilyUnanswered(
            f"Request timed out after {seconds} seconds."
        ) from exc
    except aiohttp.ClientError as exc:
        raise TavilyUnanswered(
            "An unexpected error occurred while making the request. "
            f"Error: {_unanswered_text(exc)}"
        ) from exc
