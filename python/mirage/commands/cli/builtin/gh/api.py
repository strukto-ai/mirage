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
import posixpath
import re
from typing import Any, cast
from urllib.parse import urlsplit

from mirage.commands.cli.builtin.gh.accessor import (json_out, read_cli_file,
                                                     text_out)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.github.client import github_request_response
from mirage.core.github.config import GhConfig
from mirage.core.github.placeholder import expand
from mirage.core.jq import jq_eval
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

INT_RE = re.compile(r"^-?\d+$")
KEY_RE = re.compile(r"^([^\[\]]+)((?:\[[^\[\]]*\])*)$")


class _EmptyArray:
    pass


_EMPTY_ARRAY = _EmptyArray()


def typed(value: str) -> JsonValue:
    """Read one `-F` literal as the JSON type it spells."""
    if value == "true":
        return True
    if value == "false":
        return False
    if value == "null":
        return None
    if INT_RE.match(value):
        return int(value)
    return value


def jq_line(value: JsonValue) -> str:
    """Render one jq result the way gh renders it."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def split(pair: str,
          *,
          empty_array: bool = False) -> tuple[str, str | _EmptyArray]:
    """Split one field, optionally accepting gh's empty `key[]` form."""
    key, sep, value = pair.partition("=")
    if sep:
        return key, value
    if empty_array and key.endswith("[]"):
        return key, _EMPTY_ARRAY
    raise ValueError(f'expected "key=value", got "{pair}"')


def _key_parts(key: str) -> list[str | None]:
    match = KEY_RE.fullmatch(key)
    if match is None:
        raise ValueError(f'invalid field key: "{key}"')
    parts: list[str | None] = [match.group(1)]
    parts.extend(value or None
                 for value in re.findall(r"\[([^\[\]]*)\]", match.group(2)))
    return parts


def _put(container: Any, parts: list[str | None], value: Any) -> None:
    token = parts[0]
    tail = parts[1:]
    if isinstance(token, str):
        if not isinstance(container, dict):
            raise ValueError("field nesting mixes an object and an array")
        if not tail:
            container[token] = value
            return
        wanted: Any = [] if tail[0] is None else {}
        child = container.get(token)
        if not isinstance(child, type(wanted)):
            child = wanted
            container[token] = child
        _put(child, tail, value)
        return

    if not isinstance(container, list):
        raise ValueError("field nesting mixes an object and an array")
    if not tail:
        if value is not _EMPTY_ARRAY:
            container.append(value)
        return
    wanted = [] if tail[0] is None else {}
    child = container[-1] if container else None
    reuse = isinstance(child, type(wanted))
    if reuse and isinstance(child, dict) and isinstance(tail[0], str):
        next_key = tail[0]
        reuse = next_key not in child or (len(tail) > 1 and tail[1] is None)
    if not reuse:
        child = wanted
        container.append(child)
    _put(child, tail, value)


def _set_field(fields: dict[str, Any], key: str, value: Any) -> None:
    _put(fields, _key_parts(key), value)


async def _stdin(inv: CLIInvocation[GhConfig]) -> bytes:
    if inv.stdin is None:
        raise ValueError("standard input is required")
    return await materialize(inv.stdin)


def _file_spec(inv: CLIInvocation[GhConfig], path: str) -> PathSpec:
    if path.startswith("/"):
        return PathSpec.from_str_path(path)
    cwd = inv.env.get("PWD", "/")
    return PathSpec.from_str_path(posixpath.normpath(posixpath.join(cwd,
                                                                    path)))


async def _read_file(inv: CLIInvocation[GhConfig], path: str) -> bytes:
    if path == "-":
        return await _stdin(inv)
    if inv.doors is None or inv.doors.dispatch is None:
        raise ValueError(f"read {path}: a workspace is required")
    try:
        data, _ = await inv.doors.dispatch("read", _file_spec(inv, path))
    except FileNotFoundError:
        raise ValueError(f"read {path}: No such file or directory") from None
    return data if isinstance(data, bytes) else bytes(data)


async def _field_value(inv: CLIInvocation[GhConfig], value: str) -> JsonValue:
    expanded = expand(value, inv.config)
    if expanded.startswith("@"):
        return (await _read_file(inv, expanded[1:])).decode()
    return typed(expanded)


async def _fields(inv: CLIInvocation[GhConfig],
                  fl: FlagView) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for pair in fl.as_list("raw_field"):
        key, value = split(pair)
        _set_field(fields, key, value)
    for pair in fl.as_list("field"):
        key, value = split(pair, empty_array=True)
        landed = (value if value is _EMPTY_ARRAY else await _field_value(
            inv, str(value)))
        _set_field(fields, key, landed)
    return fields


def _headers(fl: FlagView) -> dict[str, str]:
    headers: dict[str, str] = {}
    for header in fl.as_list("header"):
        key, sep, value = header.partition(":")
        if not sep or not key.strip():
            raise ValueError(f'expected "key:value", got "{header}"')
        headers[key.strip()] = value.strip()
    return headers


async def _input(inv: CLIInvocation[GhConfig],
                 fl: FlagView) -> "JsonValue | None":
    raw = fl.raw("input")
    if raw is None:
        return None
    path = raw.raw_path if isinstance(raw, PathSpec) else str(raw)
    try:
        return cast(
            JsonValue,
            json.loads((await read_cli_file(inv, raw, "--input")).decode()))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc.msg}") from None


def _query(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    return str(value)


def _next_path(link: str | None, base_url: str | None) -> str | None:
    if not link:
        return None
    for item in link.split(","):
        match = re.match(r'\s*<([^>]+)>\s*;\s*rel="([^"]+)"', item)
        if match is None or "next" not in match.group(2).split():
            continue
        target = match.group(1)
        parsed = urlsplit(target)
        path = parsed.path if parsed.scheme else target.split("?", 1)[0]
        query = parsed.query if parsed.scheme else target.partition("?")[2]
        path = path if path.startswith("/") else f"/{path}"
        base_path = urlsplit(base_url or "").path.rstrip("/")
        if base_path and (path == base_path
                          or path.startswith(f"{base_path}/")):
            path = path[len(base_path):] or "/"
        return path + (f"?{query}" if query else "")
    return None


async def api(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    """Execute the supported, noninteractive `gh api` surface."""
    fl = FlagView(inv.flags)
    endpoint = inv.texts[0] if inv.texts else ""
    if not endpoint:
        raise ValueError("an API endpoint is required")
    fields = await _fields(inv, fl)
    input_body = await _input(inv, fl)
    has_input = fl.raw("input") is not None
    method = fl.as_str("method") or ("POST" if fields or has_input else "GET")
    upper = method.upper()
    path = expand(endpoint, inv.config)
    path = path if path.startswith("/") else f"/{path}"

    params: dict[str, str] | None = None
    body: "JsonValue | None" = None
    if has_input:
        body = input_body
        params = {key: _query(value) for key, value in fields.items()} or None
    elif upper == "GET":
        params = {key: _query(value) for key, value in fields.items()} or None
    else:
        body = fields or None

    pages: list[Any] = []
    current: str | None = path
    first = True
    while current is not None:
        request_params = params if first else None
        if has_input or body is not None:
            response = await github_request_response(
                inv.config.token,
                upper,
                current,
                body,
                request_params,
                base_url=inv.config.base_url,
                headers=_headers(fl) or None)
        else:
            response = await github_request_response(
                inv.config.token,
                upper,
                current,
                params=request_params,
                base_url=inv.config.base_url,
                headers=_headers(fl) or None)
        pages.append(response.data)
        first = False
        current = (_next_path(response.headers.get("link"),
                              inv.config.base_url)
                   if fl.as_bool("paginate") else None)

    if fl.as_bool("silent"):
        return text_out("")
    slurp = fl.as_bool("slurp")
    program = fl.as_str("jq")
    if program:
        inputs = [pages] if slurp else pages
        lines = "".join(f"{jq_line(value)}\n" for item in inputs
                        for value in jq_eval(item, program))
        return text_out(lines)
    if slurp:
        return json_out(pages)
    if len(pages) == 1:
        if isinstance(pages[0], str):
            return text_out(pages[0])
        return json_out(pages[0])
    rendered = "".join("" if page is None else page if isinstance(
        page, str) else f"{json.dumps(page, indent=2, ensure_ascii=False)}\n"
                       for page in pages)
    return text_out(rendered)
