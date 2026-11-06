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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

import typer
import yaml

from mirage.cli.client import DaemonClient, make_client
from mirage.cli.output import emit, fail, format_table, handle_response
from mirage.utils.yaml import parse_yaml


@dataclass(frozen=True)
class Kind:
    """One kind of saved connection: its command, route and noun."""

    name: str
    route: str
    noun: str


KINDS: tuple[Kind, ...] = (
    Kind("vfs", "/v1/vfs", "VFS"),
    Kind("cli", "/v1/clis", "CLI"),
    Kind("runtime", "/v1/runtimes", "runtime"),
)

OUTPUTS = ("json", "yaml")

NO_ARGV_SECRET = (
    "a secret never comes from the command line: use --secret {key} to "
    "be prompted (or to read stdin), or --secret {key}=@FILE"
)


@dataclass
class Draft:
    """An entry as the flags and file build it, before it is sent."""

    name: str | None = None
    type: str | None = None
    fields: dict[str, Any] = field(default_factory=dict)
    secrets: list[tuple[str, str | None]] = field(default_factory=list)
    plain: set[str] = field(default_factory=set)


def set_value(word: str) -> tuple[str, Any]:
    """A ``--set key=value``: JSON when the value starts with ``{`` or
    ``[``, else the string.

    Args:
        word (str): the flag's value.
    """
    key, eq, raw = word.partition("=")
    if not eq or not key:
        fail(f"--set {word}: a field is key=value", exit_code=2)
    if raw.startswith(("{", "[")):
        try:
            return key, json.loads(raw)
        except json.JSONDecodeError as err:
            fail(f"--set {key} is not valid JSON: {err}", exit_code=2)
    return key, raw


def secret_source(word: str) -> tuple[str, str | None]:
    """A ``--secret key`` or ``--secret key=@FILE``: the key and the
    file to read, or None to prompt or read stdin. A value written on
    the command line is refused.

    Args:
        word (str): the flag's value.
    """
    key, eq, raw = word.partition("=")
    if not key:
        fail(f"--secret {word}: name a field", exit_code=2)
    if not eq:
        return key, None
    if not raw.startswith("@") or raw == "@":
        fail(NO_ARGV_SECRET.format(key=key), exit_code=2)
    return key, raw[1:]


def one_line(text: str) -> str:
    """A secret as read: without the one line ending a file or a pipe
    puts after it.

    Args:
        text (str): the text read.
    """
    if text.endswith("\r\n"):
        return text[:-2]
    return text.removesuffix("\n")


def read_file(path: str) -> str:
    try:
        if path == "-":
            return sys.stdin.read()
        return Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as err:
        fail(f"cannot read {path}: {err}", exit_code=2)


def label(key: str, name: str) -> str:
    return f"{key[:1].upper()}{key[1:]} for {name}"


def read_secret(key: str, path: str | None, name: str) -> str:
    """One sealed value: from its file, a hidden prompt in a terminal,
    else the next line of stdin.

    Args:
        key (str): the field.
        path (str | None): the file, or None.
        name (str): the entry, for the prompt.
    """
    if path is not None:
        return one_line(read_file(path))
    if sys.stdin.isatty():
        return str(typer.prompt(label(key, name), hide_input=True))
    line = sys.stdin.readline()
    if line == "":
        fail(f"no value on stdin for --secret {key}", exit_code=2)
    return one_line(line)


def load_draft(path: str) -> Draft:
    """An entry from a YAML or JSON file: ``name``, ``type``, ``fields``
    (or ``config``, as ``get -o yaml`` writes it) and ``secrets``, the
    sealed fields to read.

    Args:
        path (str): the file, or ``-`` for stdin.
    """
    try:
        data = parse_yaml(read_file(path))
    except yaml.YAMLError as err:
        fail(f"{path} is not YAML or JSON: {err}", exit_code=2)
    if not isinstance(data, dict):
        fail(f"{path} must hold a mapping", exit_code=2)
    fields = data.get("fields", data.get("config", {}))
    secrets = data.get("secrets", [])
    if not isinstance(fields, dict):
        fail(f"{path}: fields must be a mapping", exit_code=2)
    if not isinstance(secrets, list) or not all(
        isinstance(s, str) for s in secrets
    ):
        fail(f"{path}: secrets must be a list of field names", exit_code=2)
    for key in ("name", "type"):
        if key in data and not isinstance(data[key], str):
            fail(f"{path}: {key} must be a string", exit_code=2)
    return Draft(
        name=data.get("name"),
        type=data.get("type"),
        fields=dict(fields),
        secrets=[(s, None) for s in secrets],
    )


def apply_flags(
    draft: Draft, sets: list[str], secrets: list[str], unsets: list[str]
) -> Draft:
    """The flags applied over a draft, in the order a reader expects:
    ``--set`` then ``--unset``, with ``--secret`` read when sent.

    Args:
        draft (Draft): the entry so far.
        sets (list[str]): the ``--set`` values.
        secrets (list[str]): the ``--secret`` values.
        unsets (list[str]): the ``--unset`` keys.
    """
    for word in sets:
        key, value = set_value(word)
        draft.fields[key] = value
        draft.plain.add(key)
    for key in unsets:
        draft.fields.pop(key, None)
        draft.plain.discard(key)
    draft.secrets.extend(secret_source(word) for word in secrets)
    return draft


def is_pointer(value: Any) -> bool:
    return isinstance(value, dict) and set(value) <= {"from", "ref", "key"}


def refuse_argv_secrets(draft: Draft, spec: list[dict[str, Any]]) -> None:
    """Refuse a sealed field given by ``--set``: it would sit in the
    shell's history. A pointer to a store holds no secret, so it may.

    Args:
        draft (Draft): the entry.
        spec (list[dict[str, Any]]): the type's fields.
    """
    secret = {f["name"] for f in spec if f.get("secret")}
    for key in sorted(draft.plain & secret):
        if not is_pointer(draft.fields.get(key)):
            fail(NO_ARGV_SECRET.format(key=key), exit_code=2)


def missing_required(spec: list[dict[str, Any]], given: set[str]) -> list[str]:
    """The required fields not given, a block's only when the block is
    used, as the server checks them.

    Args:
        spec (list[dict[str, Any]]): the type's fields.
        given (set[str]): the fields given a value.
    """
    out = []
    for f in spec:
        group = f.get("group")
        used = group is None or any(
            g.get("group") == group and g["name"] in given for g in spec
        )
        if f.get("required") and used and f["name"] not in given:
            out.append(f["name"])
    return out


def type_fields(
    client: DaemonClient, kind: Kind, type: str
) -> list[dict[str, Any]]:
    types = handle_response(client.request("GET", f"{kind.route}/types"))
    if not isinstance(types, dict) or type not in types:
        known = ", ".join(types) if isinstance(types, dict) else ""
        fail(f"type must be a {kind.name}: {known}", exit_code=2)
    spec: list[dict[str, Any]] = types[type]
    return spec


def fill(draft: Draft, name: str, spec: list[dict[str, Any]]) -> None:
    """Read the sealed values, then the required fields still missing:
    prompted for in a terminal, else refused, all named at once.

    Args:
        draft (Draft): the entry.
        name (str): its name, for the prompts.
        spec (list[dict[str, Any]]): the type's fields.
    """
    for key, path in draft.secrets:
        draft.fields[key] = read_secret(key, path, name)
    given = {k for k, v in draft.fields.items() if v not in (None, "")}
    missing = missing_required(spec, given)
    if not missing:
        return
    if not sys.stdin.isatty():
        fail(f"missing required fields: {', '.join(missing)}", exit_code=2)
    secret = {f["name"] for f in spec if f.get("secret")}
    for key in missing:
        draft.fields[key] = str(
            typer.prompt(label(key, name), hide_input=key in secret)
        )


def render(obj: Any, output: str | None, human: Any) -> None:
    if output is None:
        emit(obj, human=human)
    elif output == "yaml":
        typer.echo(
            yaml.safe_dump(obj, sort_keys=False, allow_unicode=True), nl=False
        )
    elif output == "json":
        typer.echo(json.dumps(obj, indent=2, ensure_ascii=False))
    else:
        fail(f"-o takes {' or '.join(OUTPUTS)}, not {output}", exit_code=2)


def text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value)


def format_entry(entry: dict[str, Any]) -> str:
    lines = [f"name: {entry['name']}", f"type: {entry['type']}"]
    lines += [f"{k}: {text(v)}" for k, v in entry.get("config", {}).items()]
    lines += [f"{k}: (sealed)" for k in entry.get("sealed", [])]
    return "\n".join(lines)


def format_entries(listing: dict[str, Any]) -> str:
    rows = [
        [i["name"], i["type"], str(i.get("used_by", 0))]
        for i in listing.get("items", [])
    ]
    return format_table(["NAME", "TYPE", "USED BY"], rows)


def format_fields(spec: list[dict[str, Any]]) -> str:
    rows = [
        [
            f["name"],
            f["type"],
            "yes" if f.get("required") else "",
            "yes" if f.get("secret") else "",
            text(f["default"]) if "default" in f else "",
        ]
        for f in spec
    ]
    return format_table(
        ["FIELD", "TYPE", "REQUIRED", "SECRET", "DEFAULT"], rows
    )


def format_types(types: dict[str, Any]) -> str:
    rows = [
        [
            name,
            ", ".join(f["name"] for f in spec if f.get("required")),
            ", ".join(f["name"] for f in spec if f.get("secret")),
        ]
        for name, spec in types.items()
    ]
    return format_table(["TYPE", "REQUIRED", "SECRET"], rows)


OUTPUT = typer.Option(None, "--output", "-o", help="json or yaml.")
SETS = typer.Option(
    [], "--set", help="key=value; a value starting with { or [ is JSON."
)
SECRETS = typer.Option(
    [],
    "--secret",
    help="A sealed field: prompted for, read from stdin, or KEY=@FILE.",
)
UNSETS = typer.Option([], "--unset", help="Remove a field.")
FILE = typer.Option(
    None, "--file", "-f", help="The entry as YAML or JSON; - for stdin."
)


def kind_app(kind: Kind) -> typer.Typer:
    """The commands of one kind of saved connection, one per route.

    Args:
        kind (Kind): the kind.
    """
    app = typer.Typer(
        help=f"Saved {kind.noun} connections: a type, its settings and "
        "its credentials, kept by the daemon or the console.",
        no_args_is_help=True,
    )

    def entry_path(name: str) -> str:
        return f"{kind.route}/{quote(name, safe='')}"

    @app.command("types")
    def types_cmd(
        type: str | None = typer.Argument(None, help="One type's fields."),
        output: str | None = OUTPUT,
    ) -> None:
        """List the types an entry can be; with TYPE, its fields."""
        with make_client() as client:
            client.ensure_running(allow_spawn=False)
            if type is None:
                types = handle_response(
                    client.request("GET", f"{kind.route}/types")
                )
                render(types, output, format_types)
                return
            render(type_fields(client, kind, type), output, format_fields)

    @app.command("list")
    def list_cmd(
        type: str | None = typer.Option(None, "--type", help="Only TYPE."),
        q: str | None = typer.Option(None, "--query", "-q", help="Name has."),
        output: str | None = OUTPUT,
    ) -> None:
        """List the saved entries, by name."""
        params = {k: v for k, v in (("type", type), ("q", q)) if v}
        with make_client() as client:
            client.ensure_running(allow_spawn=False)
            r = client.request("GET", kind.route, params=params)
        render(handle_response(r), output, format_entries)

    @app.command("get")
    def get_cmd(
        name: str = typer.Argument(...), output: str | None = OUTPUT
    ) -> None:
        """Show an entry; a sealed field shows by name only."""
        with make_client() as client:
            client.ensure_running(allow_spawn=False)
            r = client.request("GET", entry_path(name))
        render(handle_response(r), output, format_entry)

    @app.command("create")
    def create_cmd(
        name: str | None = typer.Argument(None, help="The entry's name."),
        type: str | None = typer.Option(None, "--type", help="Its type."),
        sets: list[str] = SETS,
        secrets: list[str] = SECRETS,
        unsets: list[str] = UNSETS,
        file: str | None = FILE,
    ) -> None:
        """Save a new entry."""
        draft = load_draft(file) if file is not None else Draft()
        draft = apply_flags(draft, sets, secrets, unsets)
        draft.name = name or draft.name
        draft.type = type or draft.type
        if not draft.name:
            fail(
                f"name the entry: mirage {kind.name} create NAME", exit_code=2
            )
        if not draft.type:
            fail("give its type with --type", exit_code=2)
        with make_client() as client:
            client.ensure_running()
            spec = type_fields(client, kind, draft.type)
            refuse_argv_secrets(draft, spec)
            fill(draft, draft.name, spec)
            r = client.request(
                "POST",
                kind.route,
                json={
                    "name": draft.name,
                    "type": draft.type,
                    "fields": draft.fields,
                },
            )
        emit(
            handle_response(r),
            human=lambda e: f"Saved {kind.noun} {e['name']}.",
        )

    @app.command("update")
    def update_cmd(
        name: str = typer.Argument(..., help="The entry's name."),
        sets: list[str] = SETS,
        secrets: list[str] = SECRETS,
        unsets: list[str] = UNSETS,
        file: str | None = FILE,
    ) -> None:
        """Change an entry. Plain fields not named keep their values, as
        do sealed ones; --unset removes either."""
        with make_client() as client:
            client.ensure_running(allow_spawn=False)
            current = handle_response(client.request("GET", entry_path(name)))
            if not isinstance(current, dict):
                fail(f"{kind.noun} {name}: unexpected answer", exit_code=2)
            if file is not None:
                draft = load_draft(file)
            else:
                draft = Draft(fields=dict(current.get("config", {})))
            sealed = set(current.get("sealed", []))
            draft = apply_flags(draft, sets, secrets, unsets)
            for key in unsets:
                if key in sealed:
                    draft.fields[key] = None
            spec = type_fields(client, kind, str(current["type"]))
            refuse_argv_secrets(draft, spec)
            for key, path in draft.secrets:
                draft.fields[key] = read_secret(key, path, name)
            r = client.request(
                "PUT", entry_path(name), json={"fields": draft.fields}
            )
        emit(
            handle_response(r),
            human=lambda e: f"Updated {kind.noun} {e['name']}.",
        )

    @app.command("delete")
    def delete_cmd(name: str = typer.Argument(...)) -> None:
        """Delete an entry and wipe its sealed values; there is no
        restore. Refused while a saved template uses it."""
        with make_client() as client:
            client.ensure_running(allow_spawn=False)
            r = client.request("DELETE", entry_path(name))
        handle_response(r)
        typer.echo(f"Deleted {kind.noun} {name}.")

    return app


APPS: dict[str, typer.Typer] = {kind.name: kind_app(kind) for kind in KINDS}
