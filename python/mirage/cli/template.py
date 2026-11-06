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
from collections.abc import Callable
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import quote

import typer
import yaml

from mirage.cli.client import make_client
from mirage.cli.output import emit, fail, format_table, handle_response
from mirage.cli.settings import header
from mirage.utils.yaml import dump_yaml, parse_yaml

TEMPLATE_KEYS = frozenset({"name", "description", "config"})

app = typer.Typer(
    no_args_is_help=True,
    help="Saved workspace configs: create, list, get, delete, restore.",
)


class Output(str, Enum):
    YAML = "yaml"
    JSON = "json"


OUTPUT = typer.Option(None, "--output", "-o", help="Print as yaml or json.")


def show(obj: Any, output: Output | None, human: Callable[[Any], str]) -> None:
    """Print an answer as ``-o`` asks, else as ``emit`` does.

    Args:
        obj (Any): the answer.
        output (Output | None): ``yaml``, ``json``, or None.
        human (Callable[[Any], str]): the terminal formatter for
            ``emit``.
    """
    if output is Output.YAML:
        typer.echo(dump_yaml(obj), nl=False)
    elif output is Output.JSON:
        typer.echo(json.dumps(obj, indent=2, ensure_ascii=False))
    else:
        emit(obj, human=human)


def as_yaml(obj: Any) -> str:
    return dump_yaml(obj).rstrip()


def read_template(path: Path) -> dict[str, Any]:
    """A template file: ``{name, description?, config}`` as ``get``
    prints it, or a bare workspace config. Saved as written, with no
    ``${NAME}`` read from the environment; a relative ``script`` or code
    path is rebased onto the file's folder, as ``workspace create`` does.

    Args:
        path (Path): the YAML or JSON file.

    Returns:
        dict[str, Any]: its ``description`` and ``config``.
    """
    from mirage.config import (  # noqa: PLC0415 - cold start
        _absolutize_scripts,
    )

    try:
        doc = parse_yaml(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as e:
        fail(f"cannot read {path}: {e}", 2)
    if not isinstance(doc, dict):
        fail(f"{path} must hold a mapping", 2)
    description = None
    config = doc
    if "config" in doc and set(doc) <= TEMPLATE_KEYS:
        description = doc.get("description")
        config = doc["config"]
    if description is not None and not isinstance(description, str):
        fail(f"{path}: description must be a string", 2)
    if not isinstance(config, dict):
        fail(f"{path}: config must hold a mapping", 2)
    _absolutize_scripts(config, path.resolve().parent)
    return {"description": description, "config": config}


def template_path(name: str) -> str:
    return f"/v1/templates/{quote(name, safe='')}"


def _format_list(items: list[dict[str, Any]]) -> str:
    return format_table(
        ["NAME", "DESCRIPTION"],
        [[t["name"], t.get("description") or ""] for t in items],
    )


@app.command("create")
def create_cmd(
    name: str = typer.Argument(..., help="Template name."),
    file: Path = typer.Option(
        ...,
        "--file",
        "-f",
        exists=True,
        readable=True,
        help="A workspace config, or a template as `get -o yaml` prints it.",
    ),
    description: str | None = typer.Option(
        None, "--description", help="Say what the template is for."
    ),
) -> None:
    """Save a workspace config as a template."""
    found = read_template(file)
    body = {
        "name": name,
        "description": description
        if description is not None
        else found["description"],
        "config": found["config"],
    }
    with make_client() as client:
        client.ensure_running()
        r = client.request("POST", "/v1/templates", json=body)
    created = handle_response(r)
    header(f"created template {name}")
    emit(created, human=as_yaml)


@app.command("list")
def list_cmd(output: Output | None = OUTPUT) -> None:
    """List the saved templates."""
    with make_client() as client:
        client.ensure_running()
        r = client.request("GET", "/v1/templates")
    show(handle_response(r), output, _format_list)


@app.command("get")
def get_cmd(
    name: str = typer.Argument(..., help="Template name."),
    output: Output | None = OUTPUT,
) -> None:
    """Print a template; ``-o yaml`` is a file ``create -f`` reads."""
    with make_client() as client:
        client.ensure_running()
        r = client.request("GET", template_path(name))
    show(handle_response(r), output, as_yaml)


@app.command("delete")
def delete_cmd(name: str = typer.Argument(..., help="Template name.")) -> None:
    """Delete a template; ``restore`` brings it back."""
    with make_client() as client:
        client.ensure_running()
        r = client.request("DELETE", template_path(name))
    handle_response(r)
    header(f"deleted template {name}")
    emit({"deleted": name}, human=lambda d: f"Deleted template {name}.")


@app.command("restore")
def restore_cmd(
    name: str = typer.Argument(..., help="Template name."),
) -> None:
    """Bring back a deleted template."""
    with make_client() as client:
        client.ensure_running()
        r = client.request("POST", f"{template_path(name)}/restore")
    restored = handle_response(r)
    header(f"restored template {name}")
    emit(restored, human=as_yaml)
