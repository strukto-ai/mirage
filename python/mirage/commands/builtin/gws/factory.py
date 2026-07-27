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

import functools
import json as json_lib
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.cache.context import invalidate_after_write
from mirage.commands.builtin.gws.methods import (GWS_METHODS, SERVICE_BASES,
                                                 SERVICE_RESOURCES, GwsMethod,
                                                 gws_method_spec)
from mirage.commands.registry import command
from mirage.commands.spec.types import FlagView
from mirage.core.google._client import (TokenManager, google_delete,
                                        google_get, google_get_bytes,
                                        google_patch, google_post)
from mirage.core.google.tree_ops import DriveItemAccessor
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def invalidate_mount_listing() -> None:
    """Flush the mount's root listing after a gws mutation.

    gws commands mutate Drive items by id, so the precise vfs path is
    unknown; invalidating a synthetic root child flushes the cached root
    listing so newly created items surface in the next ls. Deeper listings
    stay cached (cases that need them use clear_cache).
    """
    await invalidate_after_write(PathSpec.from_str_path("/.gws-write"))


def _parse_json_flag(value: object, flag: str) -> dict[str, Any]:
    if not value:
        return {}
    if not isinstance(value, str):
        raise ValueError(f"{flag} must be a JSON string")
    parsed = json_lib.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError(f"{flag} must be a JSON object")
    return parsed


def fill_path(template: str, params: dict[str,
                                          Any]) -> tuple[str, dict[str, Any]]:
    """Substitute ``{placeholder}`` segments from params.

    Args:
        template (str): method path with ``{name}`` placeholders.
        params (dict): the --params object; consumed keys are removed.

    Returns:
        tuple[str, dict]: (filled path, leftover query parameters).
    """
    query = dict(params)
    path = template
    while "{" in path:
        start = path.index("{")
        end = path.index("}", start)
        name = path[start + 1:end]
        if name not in query:
            raise ValueError(f"--params must contain {name}")
        path = path[:start] + str(query.pop(name)) + path[end + 1:]
    return path, query


def _query_str(query: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in query.items():
        if isinstance(v, bool):
            out[k] = "true" if v else "false"
        else:
            out[k] = str(v)
    return out


async def _call_get(tm: TokenManager, url: str, body: dict[str, Any],
                    query: dict[str, str]) -> object:
    return await google_get(tm, url, params=query)


async def _call_post(tm: TokenManager, url: str, body: dict[str, Any],
                     query: dict[str, str]) -> object:
    return await google_post(tm, _with_query(url, query), body)


async def _call_patch(tm: TokenManager, url: str, body: dict[str, Any],
                      query: dict[str, str]) -> object:
    return await google_patch(tm, url, body, params=query)


async def _call_delete(tm: TokenManager, url: str, body: dict[str, Any],
                       query: dict[str, str]) -> object:
    await google_delete(tm, _with_query(url, query))
    return _NO_CONTENT


_NO_CONTENT = object()

_CALLERS: dict[str, Callable[..., Awaitable[object]]] = {
    "GET": _call_get,
    "POST": _call_post,
    "PATCH": _call_patch,
    "DELETE": _call_delete,
}


async def run_gws_method(
    method: GwsMethod,
    accessor: DriveItemAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    params = _parse_json_flag(_extra.get("params", ""), "--params")
    body = _parse_json_flag(_extra.get("json", ""), "--json")
    if method.needs_body and not body:
        raise ValueError("--json is required")
    token_manager: TokenManager = accessor.token_manager
    path, query = fill_path(method.path, params)
    url = SERVICE_BASES[method.service](token_manager) + path
    query_params = _query_str(query)
    if method.raw_bytes:
        data = await google_get_bytes(token_manager,
                                      _with_query(url, query_params))
        return yield_bytes(data), IOResult()
    fl = FlagView(_extra, spec=gws_method_spec(method))
    if method.http == "GET":
        # Deliberate divergence from the official gws CLI, which stops at
        # one page unless --page-all is passed: a truncated listing is
        # indistinguishable from a complete one, so mirage follows the
        # token by default and --page-limit is how you opt out.
        out = await _paginate(method, token_manager, url, body, query_params,
                              _parse_page_limit(fl.as_str("page_limit")))
        return yield_bytes(out), IOResult()
    result = await _CALLERS[method.http](token_manager, url, body,
                                         query_params)
    await invalidate_mount_listing()
    if result is _NO_CONTENT:
        return None, IOResult()
    out = json_lib.dumps(result, ensure_ascii=False,
                         separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()


def _parse_page_limit(raw: str | None) -> int | None:
    """Read --page-limit as a page count, or None for every page.

    Args:
        raw (str | None): the flag value as typed, or None when absent.
    """
    if raw is None or raw == "":
        return None
    if not raw.isdigit():
        raise ValueError(f"--page-limit must be a whole number, got '{raw}'")
    return int(raw)


async def _paginate(
    method: GwsMethod,
    token_manager: TokenManager,
    url: str,
    body: dict[str, Any],
    query: dict[str, str],
    page_limit: int | None,
) -> bytes:
    """Follow nextPageToken and emit one page response per line.

    Google list methods cap a page and hand back a token; a single call
    silently returns a partial listing. Pages are emitted as NDJSON so a
    caller can pipe straight into `jq`, which evaluates per document.

    Args:
        method (GwsMethod): the Discovery method being wrapped.
        token_manager (TokenManager): the mount's OAuth handle.
        url (str): the fully built request URL.
        body (dict): the request body, unused for GET.
        query (dict): query parameters; pageToken is overwritten per page.
        page_limit (int | None): stop after this many pages, or None for all.

    Returns:
        bytes: newline-delimited page responses.
    """
    pages: list[bytes] = []
    token: str | None = None
    fetched = 0
    while True:
        # A fresh dict per page: the callers keep the mapping they are
        # handed, so a mutated one would let a later token leak backwards.
        params = dict(query)
        if token is not None:
            params["pageToken"] = token
        result = await _CALLERS[method.http](token_manager, url, body, params)
        if result is _NO_CONTENT:
            break
        pages.append(
            json_lib.dumps(result, ensure_ascii=False,
                           separators=(",", ":")).encode())
        fetched += 1
        if page_limit is not None and fetched >= page_limit:
            break
        nxt = result.get("nextPageToken") if isinstance(result, dict) else None
        # Google always sends a string token; anything else is not one, and
        # stringifying it would send a request that can only 400.
        if not isinstance(nxt, (str, int, float)) or not nxt:
            break
        token = str(nxt)
    # A single response keeps the exact bytes an unpaginated call produced,
    # so every non-list GET is unchanged. Only a real multi-page stream is
    # newline-terminated, per the NDJSON convention.
    body_out = b"\n".join(pages)
    return body_out + b"\n" if len(pages) > 1 else body_out


def _with_query(url: str, query: dict[str, str]) -> str:
    if not query:
        return url
    sep = "&" if "?" in url else "?"
    return url + sep + "&".join(f"{k}={v}" for k, v in query.items())


def make_gws_api_commands(service: str) -> list[Callable[..., object]]:
    """Build the passthrough API commands for one gws service.

    Args:
        service (str): "drive", "docs", "sheets" or "slides".
    """
    commands: list[Callable[..., object]] = []
    for m in GWS_METHODS:
        if m.service != service:
            continue
        commands.append(
            command(m.command_name,
                    resource=SERVICE_RESOURCES[service],
                    spec=gws_method_spec(m),
                    write=m.http
                    != "GET")(functools.partial(run_gws_method, m)))
    return commands
