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

import re

from mirage.commands.cli.builtin.gh.accessor import json_out
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.github._client import github_request
from mirage.core.github.config import GhConfig
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

INT_RE = re.compile(r"^-?\d+$")


def typed(value: str) -> JsonValue:
    """Read a `-F` value as the JSON type it spells.

    `-f` is always a string; `-F` reads `true`, `false`, `null` and integers
    as their JSON types, which is gh's own split between `--raw-field` and
    `--field`.

    Args:
        value (str): the value as typed.

    Returns:
        JsonValue: the value as its JSON type.
    """
    if value == "true":
        return True
    if value == "false":
        return False
    if value == "null":
        return None
    if INT_RE.match(value):
        return int(value)
    return value


def split(pair: str) -> tuple[str, str]:
    """Split one `key=value`, keeping every `=` after the first.

    Args:
        pair (str): the field as typed.

    Returns:
        tuple[str, str]: the key and the value.

    Raises:
        ValueError: the field holds no `=`.
    """
    key, sep, value = pair.partition("=")
    if not sep:
        raise ValueError(f'expected "key=value", got "{pair}"')
    return key, value


async def api(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    endpoint = inv.texts[0] if inv.texts else ""
    if not endpoint:
        raise ValueError("an API endpoint is required")
    fields: dict[str, JsonValue] = {}
    for pair in fl.as_list("raw_field"):
        key, value = split(pair)
        fields[key] = value
    for pair in fl.as_list("field"):
        key, value = split(pair)
        fields[key] = typed(value)
    # gh sends a body-bearing call as POST unless --method says otherwise,
    # and a bare one as GET.
    method = fl.as_str("method") or ("POST" if fields else "GET")
    path = endpoint if endpoint.startswith("/") else f"/{endpoint}"
    upper = method.upper()
    # A GET carries its fields in the query string, everything else in a
    # JSON body; with no fields there is neither, so a bare DELETE has no
    # body.
    if upper == "GET":
        params = {k: _query(v) for k, v in fields.items()}
        result = await github_request(inv.config.token,
                                      upper,
                                      path,
                                      params=params or None,
                                      base_url=inv.config.base_url)
    else:
        result = await github_request(inv.config.token,
                                      upper,
                                      path,
                                      fields or None,
                                      base_url=inv.config.base_url)
    return json_out(result)


def _query(value: JsonValue) -> str:
    """One field as a query-string value.

    Args:
        value (JsonValue): the field value.

    Returns:
        str: its query-string spelling.
    """
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    return str(value)
