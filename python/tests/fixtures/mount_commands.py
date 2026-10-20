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

import importlib
import pkgutil
from collections.abc import Mapping, Sequence

import mirage.commands.builtin as builtin
from mirage.commands.builtin.generic_bind.factory import GENERIC_COMMANDS
from mirage.commands.config import Command, Context
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import materialize
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.base import BaseVFS
from mirage.workspace import Workspace
from mirage.workspace.files import Files
from mirage.workspace.mount.backends import commands_for


def mount_commands(vfs: BaseVFS) -> list[Command]:
    """The command a mount of ``vfs`` runs for each name, filetype aside:
    the VFS's own where it has one, else the generic every mount shares.

    Args:
        vfs (BaseVFS): the VFS.
    """
    served = {rc.name: rc for rc in GENERIC_COMMANDS}
    for rc in commands_for(vfs):
        if rc.filetype is None:
            served[rc.name] = rc
    return list(served.values())


def command_files(ws: Workspace) -> Files:
    """The files a line's command on ``ws`` reads and writes through: over
    the workspace's dispatcher, keeping no ledger.

    Args:
        ws (Workspace): the workspace.
    """
    return Files(
        ws.dispatch,
        ws._namespace.readers(lambda _session: None),
        ledger=False,
    )


async def run_on_mount(
    ws: Workspace,
    name: str,
    paths: Sequence[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, FlagValue] | None = None,
) -> tuple[bytes, IOResult]:
    """Run ``name`` on its first operand's mount as a line's command runs
    there, its output read whole.

    Args:
        ws (Workspace): the workspace.
        name (str): the command.
        paths (Sequence[PathSpec]): its path operands, at least one.
        texts (Sequence[str]): its text operands.
        flags (Mapping[str, FlagValue] | None): its parsed flags.
    """
    ctx = Context(vfs=command_files(ws), cwd=PathSpec.from_str_path("/"))
    mount = ws._registry.mount_for(paths[0].virtual)
    stdout, io = await mount.run_command(
        name, list(paths), list(texts), dict(flags or {}), ctx
    )
    return await materialize(stdout) or b"", io


def registered_commands() -> tuple[list[Command], list[str]]:
    """Every registered builtin command, plus modules that would not import.

    The failures are returned rather than skipped for the reason
    ``scripts/gen_specs.py`` states: a module that will not import
    registers nothing, so a command missing its delegation would pass
    this check by being absent rather than by being correct.
    """
    found: list[Command] = []
    failed: list[str] = []
    seen: set[int] = set()
    for info in pkgutil.walk_packages(
        builtin.__path__, builtin.__name__ + "."
    ):
        try:
            module = importlib.import_module(info.name)
        except ImportError as exc:
            failed.append(f"{info.name}: {exc}")
            continue
        for value in vars(module).values():
            cmds = getattr(value, "_registered_commands", None)
            if cmds is None or id(value) in seen:
                continue
            seen.add(id(value))
            found.extend(cmds)
    return found, failed
