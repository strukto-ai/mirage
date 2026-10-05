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
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlsplit

from mirage.commands.cli.builtin.gh.accessor import (
    gh_bool,
    jq_lines,
    read_cli_file,
)
from mirage.commands.cli.builtin.gh.constants import HTTP_REASONS
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import PartialOutputError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.client import GitHubApiError, github_request_response
from mirage.core.github.config import GhConfig
from mirage.core.github.constants import GRAPHQL_PATH
from mirage.core.github.placeholder import expand
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

INT_RE = re.compile(r"^-?\d+$")
KEY_RE = re.compile(r"^([^\[\]]+)((?:\[[^\[\]]*\])*)$")


class _EmptyArray:
    pass


@dataclass(frozen=True)
class _Printed:
    """One response as ``gh api`` prints it.

    Args:
        data (Any): the decoded body.
        head (str): under ``-i`` the status line and headers that go
            before it, empty otherwise.
    """

    data: Any
    head: str


@dataclass(frozen=True)
class _Failure:
    """A failing response: its body verbatim, and its head as for any
    other.

    Args:
        body (str): the body as it arrived.
        head (str): as ``_Printed.head``.
    """

    body: str
    head: str


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


def split(
    pair: str, *, empty_array: bool = False
) -> tuple[str, str | _EmptyArray]:
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
    parts.extend(
        value or None
        for value in re.findall(r"\[([^\[\]]*)\]", match.group(2))
    )
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


async def _field_value(inv: CLIInvocation[GhConfig], value: str) -> JsonValue:
    expanded = expand(value, inv.config)
    if expanded.startswith("@"):
        return (await read_cli_file(inv, expanded[1:], "--field")).decode()
    return typed(expanded)


async def _fields(
    inv: CLIInvocation[GhConfig], fl: FlagView
) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for pair in fl.as_list("raw_field"):
        key, value = split(pair)
        _set_field(fields, key, value)
    for pair in fl.as_list("field"):
        key, value = split(pair, empty_array=True)
        landed = (
            value
            if value is _EMPTY_ARRAY
            else await _field_value(inv, str(value))
        )
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


async def _input(
    inv: CLIInvocation[GhConfig], fl: FlagView
) -> "JsonValue | None":
    raw = fl.raw("input")
    if raw is None:
        return None
    path = raw.raw_path if isinstance(raw, PathSpec) else str(raw)
    try:
        return cast(
            JsonValue,
            json.loads((await read_cli_file(inv, raw, "--input")).decode()),
        )
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
        if base_path and (
            path == base_path or path.startswith(f"{base_path}/")
        ):
            path = path[len(base_path) :] or "/"
        return path + (f"?{query}" if query else "")
    return None


async def api(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
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
    if path != GRAPHQL_PATH and not path.startswith("/"):
        path = f"/{path}"

    params: dict[str, str] | None = None
    body: "JsonValue | None" = None
    if has_input:
        body = input_body
        params = {key: _query(value) for key, value in fields.items()} or None
    elif upper == "GET":
        params = {key: _query(value) for key, value in fields.items()} or None
    else:
        body = fields or None

    pages: list[_Printed] = []
    include = gh_bool(fl, "include")
    current: str | None = path
    first = True
    while current is not None:
        request_params = params if first else None
        try:
            if has_input or body is not None:
                response = await github_request_response(
                    inv.config.token,
                    upper,
                    current,
                    body,
                    request_params,
                    base_url=inv.config.base_url,
                    headers=_headers(fl) or None,
                )
            else:
                response = await github_request_response(
                    inv.config.token,
                    upper,
                    current,
                    params=request_params,
                    base_url=inv.config.base_url,
                    headers=_headers(fl) or None,
                )
        except GitHubApiError as exc:
            head = _response_head(exc.status, exc.headers) if include else ""
            return _failed(
                pages,
                fl,
                _Failure(exc.body, head),
                _server_error(exc.data, exc.status) or f"HTTP {exc.status}",
            )
        head = (
            _response_head(response.status, dict(response.headers))
            if include
            else ""
        )
        if endpoint == "graphql":
            diagnostic = _server_error(response.data, response.status)
            if diagnostic:
                text = _body_text(response.data)
                body = (
                    text.decode("utf-8", "replace")
                    if isinstance(text, bytes)
                    else text
                )
                return _failed(pages, fl, _Failure(body, head), diagnostic)
        pages.append(_Printed(response.data, head))
        first = False
        current = (
            _next_path(response.headers.get("link"), inv.config.base_url)
            if gh_bool(fl, "paginate")
            else None
        )

    return _render_pages(pages, fl), IOResult()


def _canonical(name: str) -> str:
    """gh's name for a header: each word capitalized, as Go canonicalizes
    one.

    Args:
        name (str): the header's name as it arrived.
    """
    return "-".join(
        word[:1].upper() + word[1:] for word in name.lower().split("-")
    )


def _response_head(status: int, headers: dict[str, str]) -> str:
    """The status line and headers ``gh api -i`` prints before a body.

    gh prints the protocol and status Go's client reports, then every
    header but ``Status`` in name order, each line ending ``\\r\\n``,
    then a blank ``\\r\\n`` line. Mirage's clients speak HTTP/1.1, and
    the reason is Go's phrase for the code. The body arrives decoded, so
    the headers describing its encoded form (``Content-Encoding``,
    ``Content-Length``) are dropped, which is what Go's transport does
    when it inflates a body itself.

    Args:
        status (int): the HTTP status.
        headers (dict[str, str]): the response's headers, lowercased.
    """
    decoded = "content-encoding" in headers
    dropped = {"Status"} | (
        {"Content-Encoding", "Content-Length"} if decoded else set()
    )
    lines = sorted(
        (_canonical(name), value)
        for name, value in headers.items()
        if _canonical(name) not in dropped
    )
    rows = "".join(f"{name}: {value}\r\n" for name, value in lines)
    return f"HTTP/1.1 {status} {HTTP_REASONS.get(status, '')}\n{rows}\r\n"


def _server_error(data: JsonValue, status: int) -> str:
    """What gh reports from a JSON error body, empty when it names nothing.

    gh's ``parseErrorResponse``: a string ``errors`` is the failure, with
    ``message`` in parentheses; otherwise ``message`` is, with the status;
    otherwise the messages of an ``errors`` array, one per line.

    Args:
        data (JsonValue): the decoded body.
        status (int): the HTTP status.
    """
    if not isinstance(data, dict):
        return ""
    message = data.get("message")
    message = message if isinstance(message, str) else ""
    errors = data.get("errors")
    if isinstance(errors, str) and errors:
        return f"{errors} ({message})" if message else errors
    if message:
        return f"{message} (HTTP {status})"
    if not isinstance(errors, list):
        return ""
    lines: list[str] = []
    for entry in errors:
        if isinstance(entry, str):
            lines.append(entry)
        elif isinstance(entry, dict):
            text = entry.get("message")
            lines.append(text if isinstance(text, str) else "")
    return "\n".join(lines)


def _failed(
    pages: list[_Printed], fl: FlagView, failure: _Failure, diagnostic: str
) -> tuple[ByteSource | None, IOResult]:
    return _render_pages(pages, fl, failure), IOResult(
        exit_code=1, stderr=f"gh: {diagnostic}\n".encode()
    )


def _body_text(page: Any) -> str | bytes:
    """A page's body as gh copies it out: verbatim, with no newline added.

    The body arrives decoded, and the vendor's JSON is compact, so the
    compact spelling of what arrived is the text it sent. A body that is
    not JSON is its own text, bytes that are not text (a run's log
    archive) are copied as they came, and a call that answered with none
    prints nothing.

    Args:
        page (Any): the decoded body.
    """
    if page is None:
        return ""
    if isinstance(page, (str, bytes)):
        return page
    return json.dumps(page, ensure_ascii=False, separators=(",", ":"))


def _bytes_of(parts: list[str | bytes]) -> bytes:
    return b"".join(
        part.encode() if isinstance(part, str) else part for part in parts
    )


def _joined(parts: list[list[str | bytes]], between: str) -> list[str | bytes]:
    """``parts`` flattened with ``between`` inserted between each two.

    Args:
        parts (list[list[str | bytes]]): the pieces of each response.
        between (str): what goes between two responses.
    """
    out: list[str | bytes] = []
    for index, part in enumerate(parts):
        if index:
            out.append(between)
        out.extend(part)
    return out


def _joined_pages(pages: list[Any], more: bool) -> list[str | bytes]:
    """The bodies of ``--paginate`` as gh's paginatedArrayReader streams
    them.

    A JSON array body after the first opens with a comma instead of its
    bracket (an empty one with a space), and one that more pages follow
    drops its closing bracket, so array pages print as one array. Object
    bodies, and bodies that are not JSON, run on as they came.

    Args:
        pages (list[Any]): the decoded bodies of the pages that landed.
        more (bool): whether a failing body follows the last page here.
    """
    texts: list[str | bytes] = []
    for index, page in enumerate(pages):
        text = _body_text(page)
        if (
            page is not None
            and not isinstance(page, (str, bytes))
            and isinstance(text, str)
        ):
            if index > 0 and text.startswith("["):
                text = (" " if text.startswith("[]") else ",") + text[1:]
            if (more or index < len(pages) - 1) and text.endswith("]"):
                text = text[:-1]
        texts.append(text)
    return texts


def _render_pages(
    pages: list[_Printed], fl: FlagView, failure: _Failure | None = None
) -> bytes:
    """Render the completed pages, then a failing response's body.

    gh copies the failing body out verbatim, past ``--jq``. Under
    ``--slurp`` that body is still the array's last element, even an
    empty one or one that is not JSON, which is gh's own output.

    Under ``-i`` every response's head goes before its body, a newline
    goes between two responses, and pages print as they came rather than
    joined into one array. ``--silent`` drops the bodies and keeps the
    heads, and under ``--slurp`` the array's ``[`` or ``,`` goes before a
    page's head, since gh's writer opens each page before the head is
    printed.

    Args:
        pages (list[_Printed]): the pages that landed.
        fl (FlagView): the invocation's flags.
        failure (_Failure | None): the failing response, if one failed.
    """
    include = gh_bool(fl, "include")
    between = "\n" if include else ""
    heads = [page.head for page in pages]
    failed: list[list[str | bytes]] = (
        [] if failure is None else [[failure.head, failure.body]]
    )
    if gh_bool(fl, "silent"):
        every = heads + ([] if failure is None else [failure.head])
        return _bytes_of(_joined([[head] for head in every], between))
    slurp = gh_bool(fl, "slurp")
    printed: list[list[str | bytes]] = [
        [page.head, _body_text(page.data)] for page in pages
    ]
    # gh's jsonArrayWriter: every body in one array, a comma between each.
    if slurp and failure is not None:
        return _bytes_of(["[", *_joined(printed + failed, between + ","), "]"])
    program = fl.as_str("jq")
    if program:
        if not include or slurp:
            data = [page.data for page in pages]
            return _bytes_of(
                [
                    *_joined([[head] for head in heads], between),
                    jq_lines([data] if slurp else data, program),
                    "" if failure is None else failure.body,
                ]
            )
        parts: list[list[str | bytes]] = []
        for page in pages:
            try:
                parts.append([page.head, jq_lines([page.data], program)])
            except PartialOutputError as exc:
                done = _bytes_of(_joined(parts + [[page.head]], between))
                raise PartialOutputError(str(exc), done + exc.stdout) from exc
        return _bytes_of(_joined(parts + failed, between))
    if slurp:
        return _bytes_of(["[", *_joined(printed, between + ","), "]"])
    if include:
        return _bytes_of(_joined(printed + failed, between))
    return _bytes_of(
        [
            *_joined_pages([page.data for page in pages], failure is not None),
            "" if failure is None else failure.body,
        ]
    )
