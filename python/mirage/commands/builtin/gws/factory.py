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
from mirage.commands.builtin.gws.methods import (GWS_API_SPEC, GWS_METHODS,
                                                 SERVICE_BASES,
                                                 SERVICE_RESOURCES, GwsMethod)
from mirage.commands.registry import command
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
    result = await _CALLERS[method.http](token_manager, url, body,
                                         query_params)
    if method.http != "GET":
        await invalidate_mount_listing()
    if result is _NO_CONTENT:
        return None, IOResult()
    out = json_lib.dumps(result, ensure_ascii=False,
                         separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()


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
                    spec=GWS_API_SPEC,
                    write=m.http
                    != "GET")(functools.partial(run_gws_method, m)))
    return commands
