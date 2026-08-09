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

from mirage.commands.cli.builtin.ntn.util import (compact_json, first_text,
                                                  notion_config)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagView
from mirage.core.notion._client import (notion_get, notion_patch, notion_post,
                                        notion_put)
from mirage.core.notion.config import NotionConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

BAD_DATA = "error: Invalid JSON from --data\n"

METHODS = {
    "GET": notion_get,
    "POST": notion_post,
    "PATCH": notion_patch,
    "PUT": notion_put,
}


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
        try:
            assign(body, name, json.loads(raw))
        except json.JSONDecodeError as exc:
            raise UsageError(f"{name}:= must be valid JSON") from exc
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
    raise UsageError(f"unrecognized request input: {token}")


async def api(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    path = first_text(inv.texts, "api path")
    body: dict[str, JsonValue] = {}
    params: dict[str, str] = {}
    headers: dict[str, str] = {}
    for token in inv.texts[1:]:
        classify(token, body, params, headers)

    data = fl.as_str("data")
    if data is not None:
        if body:
            raise UsageError("request body must come from one source")
        try:
            decoded = json.loads(data)
        except json.JSONDecodeError:
            # Upstream's wording and its exit 1, probed against ntn
            # 0.21.9. Deliberately not the engine's own parse message,
            # which python and typescript could never agree on.
            return None, IOResult(stderr=BAD_DATA.encode(), exit_code=1)
        if not isinstance(decoded, dict):
            raise UsageError("--data must be a JSON object")
        body = decoded

    method = (fl.as_str("method") or ("POST" if body else "GET")).upper()
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
        result = await call(config, route, body, extra_headers=headers or None)
    return yield_bytes(compact_json(result)), IOResult()
