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


from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import typer

from mirage.cli.client import make_client
from mirage.cli.output import (
    ID_HELP,
    OUTPUT,
    Output,
    emit,
    fail,
    format_table,
    handle_response,
    show,
)
from mirage.resources.constants import POLICY_NAME

app = typer.Typer(
    no_args_is_help=True,
    help="Manage saved policies: Python programs a workspace config names.",
)


NAME = typer.Argument(..., help="The policy's name, such as guard.py.")
SOURCE = typer.Option(
    ..., "--source", help="The program: @FILE reads a file, else the text."
)


def keep_policy_names(
    config: dict[str, Any], rebase: Callable[[], None]
) -> None:
    """Run ``rebase``, which turns a config's relative script paths into
    absolute ones, keeping each profile program whose ``script`` names a
    saved policy, such as ``guard.py``, as written: the server reads that
    policy's source. A path such as ``./guard.py`` is a file next to the
    config and is rebased.

    Args:
        config (dict[str, Any]): the config, rebased in place.
        rebase (Callable[[], None]): rebases ``config``'s script paths.
    """
    kept: list[tuple[dict[str, Any], str]] = []
    profiles = config.get("profiles")
    for profile in profiles.values() if isinstance(profiles, dict) else ():
        policy = profile.get("policy") if isinstance(profile, dict) else None
        for programs in policy.values() if isinstance(policy, dict) else ():
            for program in programs if isinstance(programs, list) else ():
                script = (
                    program.get("script")
                    if isinstance(program, dict)
                    else None
                )
                if isinstance(script, str) and POLICY_NAME.fullmatch(script):
                    kept.append((program, script))
    rebase()
    for program, script in kept:
        program["script"] = script


def read_source(given: str) -> str:
    """The program ``--source`` names: ``@FILE`` reads a file, anything
    else is the program itself.

    Args:
        given (str): the option's value.
    """
    if not given.startswith("@"):
        return given
    path = Path(given[1:]).expanduser()
    try:
        return path.read_text(encoding="utf-8")
    except OSError as e:
        fail(f"cannot read {path}: {e.strerror}", exit_code=2)


def call(method: str, path: str, body: dict[str, str] | None = None) -> Any:
    """One request to the daemon's ``/v1/policies``, answered as JSON.

    Args:
        method (str): the HTTP method.
        path (str): the route under ``/v1/policies``.
        body (dict[str, str] | None): the JSON body, if any.
    """
    with make_client() as client:
        client.ensure_running(allow_spawn=False)
        r: httpx.Response = client.request(
            method, f"/v1/policies{path}", json=body
        )
    return handle_response(r)


def ref(name: str) -> str:
    return f"/{quote(name, safe='')}"


def items_of(answer: Any) -> list[dict[str, Any]]:
    """A list's policies, from ``{items}`` or a bare array.

    Args:
        answer (Any): the list route's JSON.
    """
    if isinstance(answer, dict):
        return list(answer.get("items", []))
    return list(answer)


@app.command("create")
def create_cmd(name: str = NAME, source: str = SOURCE) -> None:
    """Save a new policy; a name already saved is refused."""
    saved = call("POST", "", {"name": name, "source": read_source(source)})
    emit(saved, human=lambda p: f"Created policy {p['name']}.")


@app.command("list")
def list_cmd() -> None:
    """List saved policies by name."""
    items = items_of(call("GET", ""))
    emit(
        items,
        human=lambda ps: format_table(["NAME"], [[p["name"]] for p in ps]),
    )


@app.command("get")
def get_cmd(
    name: str = typer.Argument(..., metavar="ID", help=ID_HELP),
    output: Output | None = OUTPUT,
) -> None:
    """Show one policy; in a terminal, its source."""
    show(call("GET", ref(name)), output, lambda p: p["source"].rstrip("\n"))


@app.command("update")
def update_cmd(
    name: str = typer.Argument(..., metavar="ID", help=ID_HELP),
    source: str = SOURCE,
) -> None:
    """Replace a saved policy's source."""
    saved = call("PUT", ref(name), {"source": read_source(source)})
    emit(saved, human=lambda p: f"Updated policy {p['name']}.")


@app.command("delete")
def delete_cmd(
    name: str = typer.Argument(..., metavar="ID", help=ID_HELP),
) -> None:
    """Delete a saved policy."""
    call("DELETE", ref(name))
    typer.echo(f"Deleted policy {name}.")
