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
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import typer

from mirage.cli.env import ENV_CONTEXT, ENV_DAEMON_PORT, ENV_WORKSPACE
from mirage.cli.output import emit, fail, format_table
from mirage.server.daemon_config import read_daemon_table
from mirage.server.paths import mirage_home

CONTEXTS_FILE = "contexts.json"
LOGINS_DIR = "logins"
LEGACY_LOGIN_FILE = "login.json"
LOCAL = "local"
HOSTED = "strukto"
HOSTED_URL = "https://api.strukto.ai"
DEFAULT_PORT = 8765
NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")

app = typer.Typer(
    no_args_is_help=True,
    help="The servers the CLI talks to: list, switch, forget.",
)


class ContextError(RuntimeError):
    """A context that does not exist, or one that cannot be changed."""


@dataclass
class Context:
    """One server the CLI talks to, with what it remembers there.

    Args:
        url (str): the server; empty for ``local``, whose URL follows
            the daemon's port.
        team (str | None): the team the login acts for, if the server
            names one.
        workspace (str | None): the workspace commands use when given
            none.
    """

    url: str = ""
    team: str | None = None
    workspace: str | None = None


@dataclass
class Contexts:
    """The contexts file: which context is current, and every context.

    Args:
        current (str): the current context's name.
        contexts (dict[str, Context]): every context by name; ``local``
            is always there.
    """

    current: str = LOCAL
    contexts: dict[str, Context] = field(default_factory=dict)


def contexts_path() -> Path:
    return mirage_home() / CONTEXTS_FILE


def login_path(name: str) -> Path:
    """Where a context's login is kept.

    A login kept before contexts existed belongs to ``local``, whose
    URL it was made for, and moves there on first use.

    Args:
        name (str): the context.

    Returns:
        Path: its login file.
    """
    path = mirage_home() / LOGINS_DIR / f"{name}.json"
    legacy = mirage_home() / LEGACY_LOGIN_FILE
    if name == LOCAL and legacy.exists() and not path.exists():
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.replace(legacy, path)
    return path


def check_name(name: str) -> str:
    """A context name, refused unless it is safe as a file name.

    Args:
        name (str): the name.

    Returns:
        str: the name.

    Raises:
        ContextError: it is not lowercase letters, digits, ``.``, ``_``
            and ``-``.
    """
    if not NAME.match(name):
        raise ContextError(
            f"invalid context name {name!r}: use lowercase letters, "
            "digits, '.', '_' and '-'"
        )
    return name


def read_contexts(path: Path | None = None) -> Contexts:
    """Read the contexts file; with none, only ``local``.

    Args:
        path (Path | None): the file; defaults to ``contexts_path()``.

    Returns:
        Contexts: the contexts, ``local`` among them.
    """
    use = path if path is not None else contexts_path()
    found = Contexts()
    if use.exists():
        try:
            raw = json.loads(use.read_text())
        except ValueError as e:
            raise ContextError(f"malformed {use}: {e}") from e
        found.current = str(raw.get("current", LOCAL))
        found.contexts = {
            name: Context(**entry)
            for name, entry in raw.get("contexts", {}).items()
        }
    found.contexts.setdefault(LOCAL, Context())
    return found


def write_contexts(contexts: Contexts, path: Path | None = None) -> None:
    """Store the contexts file whole, readable by this user only.

    Args:
        contexts (Contexts): the contexts.
        path (Path | None): the file; defaults to ``contexts_path()``.
    """
    use = path if path is not None else contexts_path()
    use.parent.mkdir(parents=True, exist_ok=True)
    staged = use.with_name(f".{use.name}.{os.getpid()}")
    fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(asdict(contexts), f, indent=2)
        f.write("\n")
    os.replace(staged, use)


def current_name(contexts: Contexts) -> str:
    """The context this command uses: ``--context`` or
    ``$MIRAGE_CONTEXT``, else the file's current one.

    Args:
        contexts (Contexts): the contexts.

    Returns:
        str: its name.

    Raises:
        ContextError: there is no context by that name.
    """
    name = os.environ.get(ENV_CONTEXT) or contexts.current
    if name not in contexts.contexts:
        raise ContextError(
            f"no context {name!r}; run `mirage context list`"
        )
    return name


def local_url(table: dict[str, Any], contexts: Contexts) -> str:
    """The ``local`` context's URL: the one it logged in to, else
    config.toml's ``url`` (until that key goes), else this machine at
    the port a spawned daemon listens on.

    Args:
        table (dict[str, Any]): config.toml's ``[daemon]`` table.
        contexts (Contexts): the contexts.

    Returns:
        str: the URL.
    """
    port = (
        os.environ.get(ENV_DAEMON_PORT)
        or str(table.get("port", ""))
        or DEFAULT_PORT
    )
    return (
        contexts.contexts[LOCAL].url
        or str(table.get("url", ""))
        or f"http://127.0.0.1:{port}"
    )


def current_workspace() -> str | None:
    """The workspace a command uses when given none:
    ``$MIRAGE_WORKSPACE``, else the current context's.

    Returns:
        str | None: the workspace, or None when none is selected.
    """
    env = os.environ.get(ENV_WORKSPACE)
    if env:
        return env
    contexts = read_contexts()
    return contexts.contexts[current_name(contexts)].workspace


def resolve_workspace(given: str | None) -> str:
    """The workspace to act on: ``-w``, else ``$MIRAGE_WORKSPACE``,
    else the current context's.

    Args:
        given (str | None): the ``-w`` value.

    Returns:
        str: the workspace.
    """
    found = given or current_workspace()
    if not found:
        fail(
            "no workspace selected · run `mirage workspace use <id>` "
            "or pass -w",
            2,
        )
    return found


def header(action: str, name: str | None = None) -> None:
    """Say on a terminal which context and team a command acted in,
    as ``strukto · team acme · created demo``.

    Args:
        action (str): what the command did.
        name (str | None): the context; the current one when None.
    """
    if not sys.stderr.isatty():
        return
    contexts = read_contexts()
    name = name or current_name(contexts)
    team = contexts.contexts[name].team
    parts = [name, *([f"team {team}"] if team else []), action]
    typer.echo(" · ".join(parts), err=True)


def use_workspace(workspace_id: str) -> None:
    """Make a workspace the current context's.

    Args:
        workspace_id (str): the workspace.
    """
    contexts = read_contexts()
    contexts.contexts[current_name(contexts)].workspace = workspace_id
    write_contexts(contexts)


@app.command("list")
def list_cmd() -> None:
    """List the contexts; the current one is marked."""
    contexts = read_contexts()
    current = current_name(contexts)
    table = read_daemon_table(mirage_home())
    rows = [
        {
            "name": name,
            "url": entry.url or local_url(table, contexts),
            "team": entry.team,
            "workspace": entry.workspace,
            "current": name == current,
        }
        for name, entry in sorted(contexts.contexts.items())
    ]
    emit(
        rows,
        human=lambda items: format_table(
            ["", "NAME", "URL", "TEAM", "WORKSPACE"],
            [
                [
                    "*" if r["current"] else "",
                    r["name"],
                    r["url"],
                    r["team"] or "",
                    r["workspace"] or "",
                ]
                for r in items
            ],
        ),
    )


@app.command("use")
def use_cmd(name: str = typer.Argument(..., help="Context name.")) -> None:
    """Make a context the current one."""
    contexts = read_contexts()
    if name not in contexts.contexts:
        raise ContextError(f"no context {name!r}; run `mirage context list`")
    contexts.current = name
    write_contexts(contexts)
    header("now current", name)
    emit({"current": name}, human=lambda d: f"Using context {name}.")


@app.command("delete")
def delete_cmd(
    name: str = typer.Argument(..., help="Context name."),
) -> None:
    """Forget a context and its login; ``local`` stays."""
    if name == LOCAL:
        raise ContextError("the local context cannot be deleted")
    contexts = read_contexts()
    if name not in contexts.contexts:
        raise ContextError(f"no context {name!r}; run `mirage context list`")
    del contexts.contexts[name]
    if contexts.current == name:
        contexts.current = LOCAL
    write_contexts(contexts)
    (mirage_home() / LOGINS_DIR / f"{name}.json").unlink(missing_ok=True)
    emit({"deleted": name}, human=lambda d: f"Deleted context {name}.")
