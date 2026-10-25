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

import logging
import os
import sys

import typer

from mirage.cli.env import ENV_SESSION, ENV_WORKSPACE
from mirage.cli.main import main as cli_main

logger = logging.getLogger(__name__)

PROG = "mirage-bash"


def split_args(argv: list[str]) -> str:
    """The line a shell's arguments run: options first, ``-c`` among
    them, then the line as the first operand. Other options are read
    and dropped, since the line runs in a Mirage session, not a host
    shell; ``-o`` and ``-O`` take the next argument with them.

    Args:
        argv (list[str]): the arguments after the program name.

    Returns:
        str: the line.

    Raises:
        ValueError: no ``-c``, no line after it, or operands after it.
    """
    rest = list(argv)
    command = False
    while rest and rest[0].startswith("-") and rest[0] != "-":
        flag = rest.pop(0)
        if flag == "--":
            break
        if flag.startswith("--"):
            continue
        command = command or "c" in flag
        if ("o" in flag or "O" in flag) and rest:
            rest.pop(0)
    if not command:
        raise ValueError("only -c is supported")
    if not rest:
        raise ValueError("-c: option requires an argument")
    if len(rest) > 1:
        raise ValueError("operands after the line are not supported")
    return rest[0]


def working_directory() -> str:
    """The process's working directory as a shell names it: ``$PWD``
    when that names the same directory, so a symlinked path keeps its
    name, else the resolved path."""
    cwd = os.getcwd()
    logical = os.environ.get("PWD", "")
    if not os.path.isabs(logical):
        return cwd
    try:
        same = os.path.samefile(logical, cwd)
    except OSError as e:
        logger.debug("PWD %s is not the working directory: %s", logical, e)
        return cwd
    return logical if same else cwd


def main() -> None:
    """Run ``mirage-bash -c LINE`` as ``mirage shell``: on the workspace
    ``MIRAGE_WORKSPACE`` names, as the session ``MIRAGE_SESSION`` names
    (the default one when unset), from the process's working directory.
    A coding agent that takes a shell path runs its commands this way."""
    try:
        line = split_args(sys.argv[1:])
    except ValueError as e:
        typer.echo(f"{PROG}: {e}", err=True)
        raise SystemExit(2) from e
    workspace = os.environ.get(ENV_WORKSPACE, "")
    if not workspace:
        typer.echo(f"{PROG}: {ENV_WORKSPACE} is not set", err=True)
        raise SystemExit(2)
    args = ["shell", "-w", workspace, f"--cwd={working_directory()}"]
    session = os.environ.get(ENV_SESSION, "")
    if session:
        args += ["-s", session]
    cli_main([*args, f"--command={line}"])
