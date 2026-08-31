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
import re
from datetime import datetime, timezone
from typing import Any

import aiohttp

from mirage.accessor.jaeger import JaegerAccessor
from mirage.core.api.client import api_request

TRACE_ID_RE = re.compile(r"^[0-9a-f]{16}$|^[0-9a-f]{32}$", re.IGNORECASE)

# Jaeger's own query service self-instruments, so a `jaeger` service shows up
# in listings alongside the ones a user actually sent.


class JaegerApiError(Exception):

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def is_trace_id(value: str) -> bool:
    """Report whether a name is a syntactically valid Jaeger trace id.

    Checked before calling the API so a malformed id becomes ENOENT instead of
    the API's 400 "invalid length for TraceID".

    Args:
        value (str): candidate trace id.

    Returns:
        bool: True when the value is 16 or 32 hex digits.
    """
    return bool(TRACE_ID_RE.match(value))


def _micros(iso: str | None, default: int) -> int:
    """Convert an ISO-8601 timestamp to unix microseconds.

    Args:
        iso (str | None): timestamp, or None to use the default.
        default (int): value used when iso is None.

    Returns:
        int: unix epoch microseconds.
    """
    if iso is None:
        return default
    parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1_000_000)


def _now_micros() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1_000_000)


def _error_of(resp: aiohttp.ClientResponse, text: str) -> Exception:
    """Map a Jaeger error response to a JaegerApiError.

    Args:
        resp (aiohttp.ClientResponse): a response with status >= 400.
        text (str): the response body.

    Returns:
        Exception: JaegerApiError carrying the API's message when the body
            supplies one, the HTTP status otherwise.
    """
    message = f"Jaeger API error: HTTP {resp.status}"
    try:
        body = json.loads(text)
    except ValueError:
        body = None
    if isinstance(body, dict):
        errors = body.get("errors")
        if isinstance(errors, list) and errors:
            first = errors[0]
            if isinstance(first, dict) and first.get("msg"):
                message = str(first["msg"])
    return JaegerApiError(message, resp.status)


async def _get(accessor: JaegerAccessor,
               endpoint: str,
               params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Call the Jaeger query API and return the decoded body.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        endpoint (str): API path beginning with a slash.
        params (dict[str, Any] | None): query string arguments.

    Returns:
        dict[str, Any]: decoded JSON body.

    Raises:
        JaegerApiError: the API reported an error status.
    """
    url = f"{accessor.config.host.rstrip('/')}{endpoint}"
    payload = await api_request("GET",
                                url,
                                error_of=_error_of,
                                params=params,
                                session=accessor.pool)
    if not isinstance(payload, dict):
        raise JaegerApiError("Jaeger response must be a JSON object")
    return payload


def _data_list(payload: dict[str, Any]) -> list[Any]:
    data = payload.get("data")
    return data if isinstance(data, list) else []


async def fetch_services(accessor: JaegerAccessor) -> list[str]:
    """List service names known to Jaeger.

    Args:
        accessor (JaegerAccessor): jaeger accessor.

    Returns:
        list[str]: service names, self-instrumentation included.
    """
    payload = await _get(accessor, "/api/services")
    return [str(name) for name in _data_list(payload)]


async def fetch_operations(accessor: JaegerAccessor,
                           service: str) -> list[dict[str, Any]]:
    """List operations recorded for a service.

    An unknown service yields an empty list rather than an error, so callers
    that need existence semantics must check the service list first.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        service (str): service name.

    Returns:
        list[dict[str, Any]]: operation records.
    """
    payload = await _get(accessor, "/api/operations", {"service": service})
    return [row for row in _data_list(payload) if isinstance(row, dict)]


async def fetch_traces(
    accessor: JaegerAccessor,
    service: str,
    limit: int = 100,
    from_timestamp: str | None = None,
    to_timestamp: str | None = None,
) -> list[dict[str, Any]]:
    """Search traces for a service within an explicit time window.

    `service` is required by the API and `lookback` is ignored, so the window
    is always sent as explicit microsecond bounds.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        service (str): service name to search.
        limit (int): maximum traces to return.
        from_timestamp (str | None): lower bound, or None for the beginning.
        to_timestamp (str | None): upper bound, or None for now.

    Returns:
        list[dict[str, Any]]: trace documents.
    """
    params = {
        "service": service,
        "limit": limit,
        "start": _micros(from_timestamp, 0),
        "end": _micros(to_timestamp, _now_micros()),
    }
    payload = await _get(accessor, "/api/traces", params)
    return [row for row in _data_list(payload) if isinstance(row, dict)]


async def fetch_trace(accessor: JaegerAccessor,
                      trace_id: str) -> dict[str, Any]:
    """Fetch one trace by id.

    Args:
        accessor (JaegerAccessor): jaeger accessor.
        trace_id (str): 16 or 32 hex digit trace id.

    Returns:
        dict[str, Any]: the trace document.

    Raises:
        JaegerApiError: the trace is missing or the API failed.
    """
    payload = await _get(accessor, f"/api/traces/{trace_id}")
    traces = [row for row in _data_list(payload) if isinstance(row, dict)]
    if not traces:
        raise JaegerApiError("trace not found", 404)
    return traces[0]
