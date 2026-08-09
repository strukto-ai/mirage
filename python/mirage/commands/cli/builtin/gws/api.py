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
from enum import Enum, auto
from typing import Any

from mirage.cache.context import invalidate_after_write
from mirage.commands.cli.builtin.gws.methods import (GWS_METHODS,
                                                     SERVICE_BASES, GwsMethod,
                                                     gws_method_description)
from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagValue, FlagView, Option
from mirage.core.google._client import (TokenManager, drive_base,
                                        google_delete, google_get,
                                        google_get_bytes, google_patch,
                                        google_post)
from mirage.core.google.config import GoogleConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

_PARAMS_HELP = ("JSON object of path and query parameters, e.g. "
                "'{\"fileId\":\"abc\"}'")
_JSON_HELP = "JSON request body, the API resource for this method"
_PAGE_ALL_HELP = ("Follow nextPageToken to the end (the default); pages "
                  "print as one JSON response per line")
_PAGE_LIMIT_HELP = "Stop after this many pages instead of reading them all"

API_OPTIONS: tuple[Option, ...] = (
    Option(long="--params", type="str", description=_PARAMS_HELP),
    Option(long="--json", type="str", description=_JSON_HELP),
    Option(long="--page-all", description=_PAGE_ALL_HELP),
    Option(long="--page-limit", type="str", description=_PAGE_LIMIT_HELP),
)


async def invalidate_mount_listing() -> None:
    """Flush a mounted listing after a gws mutation, when one is cached.

    gws commands mutate Drive items by id, so the precise vfs path is
    unknown; invalidating a synthetic root child flushes the cached root
    listing so newly created items surface in the next ls. No-op when no
    cache manager is active (the usual case for a CLI line).
    """
    await invalidate_after_write(PathSpec.from_str_path("/.gws-write"))


def _parse_json_flag(value: FlagValue | None, flag: str) -> dict[str, Any]:
    if not value:
        return {}
    if not isinstance(value, str):
        raise UsageError(f"{flag} must be a JSON string")
    try:
        parsed = json_lib.loads(value)
    except json_lib.JSONDecodeError as exc:
        # One wording in both languages: the engines' own parse messages
        # ("Expecting value" vs "Unexpected token") can never agree.
        raise UsageError(f"{flag} must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise UsageError(f"{flag} must be a JSON object")
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
            raise UsageError(f"--params must contain {name}")
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


class _NoContent(Enum):
    """A 204 body: distinct from a JSON null, which is a value."""
    TOKEN = auto()


_NO_CONTENT = _NoContent.TOKEN


async def _call_get(tm: TokenManager, url: str, body: dict[str, Any],
                    query: dict[str, str]) -> JsonValue:
    return await google_get(tm, url, params=query)


async def _call_post(tm: TokenManager, url: str, body: dict[str, Any],
                     query: dict[str, str]) -> JsonValue:
    return await google_post(tm, _with_query(url, query), body)


async def _call_patch(tm: TokenManager, url: str, body: dict[str, Any],
                      query: dict[str, str]) -> JsonValue:
    return await google_patch(tm, url, body, params=query)


async def _call_delete(tm: TokenManager, url: str, body: dict[str, Any],
                       query: dict[str, str]) -> _NoContent:
    await google_delete(tm, _with_query(url, query))
    return _NO_CONTENT


_CALLERS: dict[str, Callable[..., Awaitable["JsonValue | _NoContent"]]] = {
    "GET": _call_get,
    "POST": _call_post,
    "PATCH": _call_patch,
    "DELETE": _call_delete,
}


def scope_request(
    method: GwsMethod,
    config: GoogleConfig,
    body: dict[str, Any],
    params: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Default a create's parents to the installation's folder scope.

    A folder-scoped install is pointed at one folder, which is the same
    folder a gdrive mount sharing the config exposes. A create with no
    parents would land in My Drive's root instead, outside the mount, so
    the agent's own `ls` would never show what it just made. An explicit
    parents array always wins, and "explicit" means the key is present,
    not that it holds anything: ``"parents": []`` is a caller saying
    where the file goes just as much as ``"parents": ["root"]`` is, and
    reading it as absent would silently relocate their file.

    The injected parent brings ``supportsAllDrives`` with it, because a
    folder scope may name a Shared Drive folder and Drive rejects a
    create into one from a client that has not declared itself shared
    drive aware. Only the injected case adds it: a caller who typed
    their own parents is making a passthrough call and owns its query,
    the same way the official CLI leaves it to them.

    Args:
        method (GwsMethod): the Discovery method being wrapped.
        config (GoogleConfig): the installation's config.
        body (dict): the parsed --json request body.
        params (dict): the parsed --params object.

    Returns:
        tuple[dict, dict]: the (body, params) to send.
    """
    if method.placement != "parents" or not config.folder_id:
        return body, params
    if "parents" in body:
        return body, params
    scoped = {**body, "parents": [config.folder_id]}
    # params last: an explicitly typed supportsAllDrives still wins.
    return scoped, {"supportsAllDrives": True, **params}


async def place_in_scope(method: GwsMethod, token_manager: TokenManager,
                         result: dict[str, Any]) -> None:
    """Move a newly created editor file into the folder scope.

    The Docs, Sheets and Slides create methods have no parents field at
    all, so a new file always lands in My Drive's root; placing it takes a
    second Drive call. Doing it here is what lets `gws sheets spreadsheets
    create` put the file where the mount is, instead of leaving the caller
    to know that placement was even a question.

    ``supportsAllDrives`` rides along for the same reason every other
    Drive helper in the repo sends it: without it a scope naming a
    Shared Drive folder fails the move, and the create has already
    happened, so the file would be stranded in My Drive.

    Args:
        method (GwsMethod): the Discovery method being wrapped.
        token_manager (TokenManager): the installation's OAuth handle.
        result (dict): the create response, carrying the new file's id.
    """
    folder_id = token_manager.config.folder_id
    file_id = result.get(method.id_field)
    if not folder_id or not isinstance(file_id, str):
        return
    await google_patch(token_manager,
                       f"{drive_base(token_manager)}/files/{file_id}", {},
                       params={
                           "addParents": folder_id,
                           "removeParents": "root",
                           "supportsAllDrives": "true",
                       })


async def run_gws_method(
        method: GwsMethod, inv: CLIInvocation[GoogleConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    params = _parse_json_flag(fl.as_str("params") or "", "--params")
    body = _parse_json_flag(fl.as_str("json") or "", "--json")
    if method.needs_body and not body:
        raise UsageError("--json is required")
    body, params = scope_request(method, inv.config, body, params)
    token_manager = TokenManager(inv.config)
    path, query = fill_path(method.path, params)
    url = SERVICE_BASES[method.service](token_manager) + path
    query_params = _query_str(query)
    if method.raw_bytes:
        data = await google_get_bytes(token_manager,
                                      _with_query(url, query_params))
        return yield_bytes(data), IOResult()
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
    if method.placement == "relocate" and isinstance(result, dict):
        await place_in_scope(method, token_manager, result)
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
    # isascii() as well as isdigit(): bare isdigit() accepts non-ASCII digits
    # that TypeScript's /^\d+$/ rejects, and superscripts that int() cannot
    # parse at all.
    if not (raw.isascii() and raw.isdigit()):
        raise UsageError(f"--page-limit must be a whole number, got '{raw}'")
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
        token_manager (TokenManager): the installation's OAuth handle.
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


def method_leaf(method: GwsMethod) -> CLISpec:
    """Build the CLI leaf for one Discovery passthrough method.

    Args:
        method (GwsMethod): the Discovery method being wrapped.
    """
    return CLISpec(
        name=method.method,
        description=gws_method_description(method),
        fn=functools.partial(run_gws_method, method),
        write=method.http != "GET",
        options=API_OPTIONS,
    )


def _build_group(name: str, node: dict[str, Any]) -> CLISpec:
    leaves = tuple(method_leaf(m) for m in node.get("__methods__", ()))
    groups = tuple(
        _build_group(child, sub) for child, sub in node.items()
        if child != "__methods__")
    return CLISpec(name=name,
                   description=f"Google API {name} methods",
                   subcommands=leaves + groups)


def api_groups(service: str) -> tuple[CLISpec, ...]:
    """Build one service's passthrough subtree from the method table.

    Multi-word Discovery resources ("users messages attachments") become
    nested groups, so `gws gmail users messages get` walks like any other
    tree path.

    Args:
        service (str): "drive", "docs", "sheets", "slides" or "gmail".
    """
    root: dict[str, Any] = {}
    for m in GWS_METHODS:
        if m.service != service:
            continue
        node = root
        for word in m.resource.split():
            node = node.setdefault(word, {})
        node.setdefault("__methods__", []).append(m)
    return tuple(_build_group(name, sub) for name, sub in root.items())
