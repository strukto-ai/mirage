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
from dataclasses import replace

from mirage.commands.cli.types import CLI
from mirage.commands.config import Command, registered_commands
from mirage.vfs.base import BaseVFS

# The module holding each builtin VFS class's shell commands (its
# ``COMMANDS``), by the class's module path, so a class of the same name
# defined elsewhere is not taken for the builtin. Imported on first mount,
# so a workspace loads only the backends it mounts.
_MODULES: dict[str, str] = {
    "mirage.vfs.chroma.chroma.ChromaVFS": "mirage.commands.builtin.chroma",
    "mirage.vfs.dev.dev.DevVFS": "mirage.commands.builtin.dev",
    "mirage.vfs.dify.dify.DifyVFS": "mirage.commands.builtin.dify",
    "mirage.vfs.lancedb.lancedb.LanceDBVFS": "mirage.commands.builtin.lancedb",
    "mirage.vfs.mem0.mem0.Mem0VFS": "mirage.commands.builtin.mem0",
    "mirage.vfs.qdrant.qdrant.QdrantVFS": "mirage.commands.builtin.qdrant",
}


def backend_commands(vfs: BaseVFS) -> list[Command]:
    """The shell commands a builtin backend module serves on a mount of
    ``vfs``: mirage's own, beside the generic set.

    They are its command module's, found through the first class in its
    hierarchy that has one; a command registered under that class's name
    is registered under the VFS's own instead, so a subclass under its
    own name serves its base's commands as itself. A VFS no builtin
    module serves has none.

    Args:
        vfs (BaseVFS): the VFS being mounted.
    """
    found: list[Command] = []
    for klass in type(vfs).__mro__:
        module = _MODULES.get(f"{klass.__module__}.{klass.__qualname__}")
        if module is None:
            continue
        family = klass.__dict__.get("name", vfs.name)
        found = [
            replace(rc, vfs=vfs.name) if rc.vfs == family else rc
            for rc in registered_commands(
                importlib.import_module(module).COMMANDS
            )
        ]
        break
    return found


def commands_for(vfs: BaseVFS) -> list[Command | CLI]:
    """The shell commands a mount of ``vfs`` serves beside the generic set.

    A builtin's backend module's first (``backend_commands``), then the
    commands the VFS was handed, so they win; a command tree it was handed
    stays a ``CLI``, which the mount registers under its root's name. A
    name none of these has falls back to the generic command every mount
    shares.

    Args:
        vfs (BaseVFS): the VFS being mounted.
    """
    handed: list[Command | CLI] = []
    for item in vfs.commands():
        if isinstance(item, CLI):
            handed.append(item)
        else:
            handed.extend(registered_commands([item]))
    return [*backend_commands(vfs), *handed]
