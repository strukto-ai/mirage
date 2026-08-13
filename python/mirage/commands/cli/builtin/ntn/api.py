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
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.commands.cli.builtin.ntn.serde import serde_message
from mirage.commands.cli.builtin.ntn.util import (compact_json, first_text,
                                                  notion_config, rust_debug)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagView
from mirage.core.notion._client import (notion_delete, notion_get,
                                        notion_patch, notion_post, notion_put)
from mirage.core.notion.config import NotionConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import JsonValue

# Every byte below is probed against ntn 0.21.9. The exit codes are not
# one family: a body that arrived malformed is 1, while a line the CLI
# refuses to interpret at all is 5, and neither is argparse's 2.
BAD_DATA = "error: Invalid JSON from --data\n"
BAD_STDIN = "error: Invalid JSON from stdin\n"
EMPTY_DATA = (
    "error: --data requires a valid JSON value.\n"
    "  hint: Pass a JSON string such as `--data '{\"foo\":\"bar\"}'`, a file "
    "such as `--data @body.json`, or stdin with `--data @-`.\n")
INLINE_LEAD = "error: Failed to parse inline request input: "
INLINE_HINT = ("  hint: Use `Header:Value`, `name==value`, `path=value`, or "
               "`path:=json`.\n")
CONFLICT_LEAD = "error: Request body can come from only one source, but got: "
CONFLICT_HINT = ("  hint: Use only one of: stdin JSON, `--data`, or "
                 "`path=value` / `path:=json` inputs.\n")
STDIN_SOURCE = "stdin JSON"
DATA_SOURCE = "--data"
INLINE_SOURCE = "inline body inputs"
BAD_BODY_EXIT = 1
REFUSAL_EXIT = 5

# The write verbs share one shape and `notion_get` does not (a query
# where they take a body), so the table is typed by what every entry
# returns rather than by a signature that would fit neither. Only the
# write verbs are ever called through it: the GET branch calls
# `notion_get` by name, and this mapping also answers "is that a method
# at all".
NotionCall = Callable[..., Awaitable[dict[str, Any]]]

# DELETE is here because `DELETE /v1/blocks/{id}` is the only delete verb the
# public API has, so without it the one way to remove anything is unreachable
# from this CLI. It takes no body, which is why it is reached through `-X`
# rather than by a body source inferring it.
METHODS: dict[str, NotionCall] = {
    "GET": notion_get,
    "POST": notion_post,
    "PATCH": notion_patch,
    "PUT": notion_put,
    "DELETE": notion_delete,
}


class InlineRefusal(Exception):
    """One inline input the CLI could not interpret.

    Args:
        detail (str): the clause upstream puts after its fixed lead,
            already rendered.
    """

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def assign(body: dict[str, JsonValue], path: str, value: JsonValue) -> None:
    """Set a bracket path (`a[b][0][c]`) inside a request body.

    Args:
        body (dict[str, JsonValue]): the body being built.
        path (str): the assignment's left-hand side.
        value (JsonValue): the value to store at it.
    """
    head, _, tail = path.partition("[")
    keys = [head]
    for chunk in tail.split("[") if tail else []:
        keys.append(chunk.rstrip("]"))
    cursor: JsonValue = body
    for index, key in enumerate(keys[:-1]):
        step = keys[index + 1]
        blank: JsonValue = [] if step == "" or step.isdigit() else {}
        cursor = descend(cursor, key, blank)
    place(cursor, keys[-1], value)


def descend(cursor: JsonValue, key: str, blank: JsonValue) -> JsonValue:
    """Walk one level into a body being built, creating the container.

    Args:
        cursor (JsonValue): the container to step into.
        key (str): the key or index at this level.
        blank (JsonValue): the container to create when absent.

    Returns:
        JsonValue: the container one level down.
    """
    if isinstance(cursor, list):
        if key == "" or int(key) >= len(cursor):
            cursor.append(blank)
            return cursor[-1]
        return cursor[int(key)]
    if isinstance(cursor, dict):
        if key not in cursor:
            cursor[key] = blank
        return cursor[key]
    raise UsageError(f"cannot assign through {key}")


def place(cursor: JsonValue, key: str, value: JsonValue) -> None:
    """Store the leaf value of a bracket path.

    Args:
        cursor (JsonValue): the container to store into.
        key (str): the key or index to store at.
        value (JsonValue): the value.
    """
    if isinstance(cursor, list):
        if key == "" or int(key) >= len(cursor):
            cursor.append(value)
            return
        cursor[int(key)] = value
        return
    if isinstance(cursor, dict):
        cursor[key] = value
        return
    raise UsageError(f"cannot assign through {key}")


def classify(token: str, body: dict[str, JsonValue], params: dict[str, str],
             headers: dict[str, str]) -> None:
    """Sort one inline input into the body, query, or headers.

    Precedence is the upstream CLI's, and it is order-sensitive:
    ``path:=json`` beats ``name==value`` beats ``Header:Value`` beats
    ``path=value``, so a value containing one separator cannot be
    reclassified by another appearing later in it.

    Args:
        token (str): the raw argument.
        body (dict[str, JsonValue]): body accumulator.
        params (dict[str, str]): query accumulator.
        headers (dict[str, str]): header accumulator.
    """
    if ":=" in token:
        name, _, raw = token.partition(":=")
        # serde decides, not python's json: the two disagree about what
        # is valid (`NaN` parses here and not there) and never agree on
        # the wording, and this message is compared byte for byte.
        message = serde_message(raw)
        if message is not None:
            raise InlineRefusal(f"invalid JSON value in {rust_debug(token)}: "
                                f"{message}")
        assign(body, name, json.loads(raw))
        return
    if "==" in token:
        name, _, raw = token.partition("==")
        params[name] = raw
        return
    if ":" in token and "=" not in token.split(":", 1)[0]:
        name, _, raw = token.partition(":")
        headers[name] = raw
        return
    if "=" in token:
        name, _, raw = token.partition("=")
        assign(body, name, raw)
        return
    raise InlineRefusal(f"unexpected input: {rust_debug(token)}")


def refusal(stderr: str, code: int) -> tuple[None, IOResult]:
    """One of upstream's own refusals, rendered.

    Args:
        stderr (str): the complete message, newline included.
        code (int): the exit status upstream pairs with it.
    """
    return None, IOResult(stderr=stderr.encode(), exit_code=code)


async def api(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    path = first_text(inv.texts, "api path")

    # Upstream validates the three body sources in this order and only
    # then complains that more than one was given, so a malformed pipe
    # outranks a malformed --data, and both outrank the conflict. Probed
    # against ntn 0.21.9; the order is observable and worth keeping.
    piped = await materialize(inv.stdin) if inv.stdin is not None else b""
    stdin_text = piped.decode("utf-8", "replace")
    has_stdin = stdin_text.strip() != ""
    stdin_body: JsonValue = None
    if has_stdin:
        if serde_message(stdin_text) is not None:
            return refusal(BAD_STDIN, BAD_BODY_EXIT)
        stdin_body = json.loads(stdin_text)

    data = fl.as_str("data")
    has_data = data is not None
    data_body: JsonValue = None
    if data is not None:
        if data.strip() == "":
            return refusal(EMPTY_DATA, REFUSAL_EXIT)
        if serde_message(data) is not None:
            return refusal(BAD_DATA, BAD_BODY_EXIT)
        data_body = json.loads(data)

    inline: dict[str, JsonValue] = {}
    params: dict[str, str] = {}
    headers: dict[str, str] = {}
    try:
        for token in inv.texts[1:]:
            classify(token, inline, params, headers)
    except InlineRefusal as caught:
        return refusal(f"{INLINE_LEAD}{caught.detail}\n{INLINE_HINT}",
                       REFUSAL_EXIT)

    named = [
        name
        for name, given in ((STDIN_SOURCE, has_stdin), (DATA_SOURCE, has_data),
                            (INLINE_SOURCE, bool(inline))) if given
    ]
    if len(named) > 1:
        return refusal(f"{CONFLICT_LEAD}{', '.join(named)}.\n{CONFLICT_HINT}",
                       REFUSAL_EXIT)

    # A body source makes the call a POST even when what it carries is
    # empty: `--data {}` posts, and there is no object check anywhere,
    # so a list or a scalar goes out exactly as it was typed.
    body: JsonValue = None
    if has_stdin:
        body = stdin_body
    elif has_data:
        body = data_body
    elif inline:
        body = inline

    method = (fl.as_str("method") or ("POST" if named else "GET")).upper()
    call = METHODS.get(method)
    if call is None:
        raise UsageError(f"unsupported method: {method}")
    route = path if path.startswith("/") else f"/{path}"
    route = route[3:] if route.startswith("/v1/") else route
    config = notion_config(inv)
    if method == "GET":
        result = await notion_get(config,
                                  route,
                                  params=params or None,
                                  extra_headers=headers or None)
    else:
        # `name==value` is a query parameter whatever the method is, so
        # it rides alongside the body rather than being dropped the
        # moment the call stops being a GET.
        result = await call(config,
                            route,
                            body,
                            extra_headers=headers or None,
                            params=params or None)
    return yield_bytes(compact_json(result)), IOResult()
