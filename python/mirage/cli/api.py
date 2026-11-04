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
import sys
from pathlib import Path
from typing import Any

import typer
import yaml

from mirage.cli.client import make_client
from mirage.cli.output import emit, fail, handle_response


def _text(path: str) -> str:
    """A file's text, or stdin's for ``-``.

    Args:
        path (str): the file, or ``-``.
    """
    if path == "-":
        return sys.stdin.read()
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError as err:
        fail(f"cannot read {path}: {err}", exit_code=2)


def field_value(key: str, raw: str) -> Any:
    """A field's value: JSON when it starts with ``{`` or ``[``, the
    file's text for ``@file`` (``@-`` stdin), else the string. Mirrors
    TypeScript's ``fieldValue``.

    Args:
        key (str): the field's key, for the error.
        raw (str): the value as given.
    """
    if raw.startswith(("{", "[")):
        try:
            return json.loads(raw)
        except json.JSONDecodeError as err:
            fail(f"--{key} is not valid JSON: {err}", exit_code=2)
    if raw.startswith("@"):
        return _text(raw[1:])
    return raw


def parse_fields(words: list[str]) -> list[tuple[str, Any]]:
    """The fields in the words after the route: ``--key value``,
    ``--key=value``, or a bare ``--flag``, which is ``True``. Mirrors
    TypeScript's ``parseFields``.

    Args:
        words (list[str]): the words after the route.
    """
    fields: list[tuple[str, Any]] = []
    i = 0
    while i < len(words):
        word = words[i]
        key, eq, raw = word[2:].partition("=")
        if not word.startswith("--") or not key:
            fail(f"{word}: a field is --key value", exit_code=2)
        if eq:
            fields.append((key, field_value(key, raw)))
        elif i + 1 == len(words) or words[i + 1].startswith("--"):
            fields.append((key, True))
        else:
            fields.append((key, field_value(key, words[i + 1])))
            i += 1
        i += 1
    return fields


def api_cmd(
    ctx: typer.Context,
    route: str = typer.Argument(
        ..., metavar="PATH", help="The route, such as /v1/workspaces."
    ),
    method: str | None = typer.Option(
        None,
        "--method",
        "-X",
        help="The HTTP method: GET, or POST with fields or --input.",
    ),
    input_file: str | None = typer.Option(
        None,
        "--input",
        help="The body, from a YAML or JSON file; - reads stdin.",
    ),
) -> None:
    """Call a route of the server, with the CLI's login.

    Every other option is a field: --key value or --key=value. A value
    starting with { or [ is JSON, @file reads the file (@- stdin), and a
    bare --flag is true. Fields make a JSON body, or the query string of
    a GET; --input sends a YAML or JSON file as the body instead.
    """
    if "://" in route or route.startswith("-"):
        fail(
            "api takes a route of the server first, such as /v1/workspaces",
            exit_code=2,
        )
    fields = parse_fields(ctx.args)
    if input_file is not None and fields:
        fail("give fields or --input, not both", exit_code=2)
    has_body = input_file is not None or bool(fields)
    verb = (method or ("POST" if has_body else "GET")).upper()
    if verb in ("GET", "HEAD") and input_file is not None:
        fail(f"{verb} takes no body; give -X", exit_code=2)
    body: Any = None
    if input_file is not None:
        try:
            body = yaml.safe_load(_text(input_file))
        except yaml.YAMLError as err:
            fail(f"invalid YAML/JSON in {input_file}: {err}", exit_code=2)
    elif fields:
        body = dict(fields)
    path = route if route.startswith("/") else f"/{route}"
    params: list[tuple[str, str]] = []
    if verb in ("GET", "HEAD"):
        # As gh does: a GET's fields are its query string.
        params = [(key, _query_text(value)) for key, value in fields]
        has_body = False
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        if has_body:
            r = client.request(verb, path, json=body)
        else:
            r = client.request(verb, path, params=params)
    if r.status_code >= 400:
        handle_response(r)
    if not r.content:
        return
    if "json" in r.headers.get("content-type", ""):
        emit(r.json())
    else:
        typer.echo(r.text, nl=False)


def _query_text(value: Any) -> str:
    """A field's value as a query string spells it: a string as itself,
    else its JSON, as TypeScript's ``JSON.stringify`` writes it.

    Args:
        value (Any): the field's value.
    """
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
