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

from collections.abc import Mapping
from typing import Any

from mirage.policy.profile import command_tree
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandNode,
    ScopedTree,
)
from mirage.types import PathSpec
from mirage.workspace.executor.command.reading import read_line
from mirage.workspace.lookup.constants import line_facts
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.validate import BUILTIN_GRAMMARS, normalize_tree


def tree(block: Mapping[str, Any]) -> CommandNode:
    """A ``commands`` block read and held by the built-in grammars'
    canonical names, as a session holds it.

    Args:
        block (Mapping[str, Any]): the block as a profile writes it.
    """
    return normalize_tree(command_tree(block), BUILTIN_GRAMMARS, defer=True)


def trees(
    commands: Mapping[str, Any] | None = None,
    mounts: Mapping[str, Mapping[str, Any]] | None = None,
    inline: Mapping[str, Any] | None = None,
) -> AdmissionRules:
    """A session's command trees from blocks as a profile writes them.

    Args:
        commands (Mapping[str, Any] | None): the top-level block.
        mounts (Mapping[str, Mapping[str, Any]] | None): each mount's
            block, by prefix.
        inline (Mapping[str, Any] | None): inline permissions' block.
    """
    out = [] if commands is None else [ScopedTree(tree(commands))]
    out += [
        ScopedTree(tree(b), prefix) for prefix, b in (mounts or {}).items()
    ]
    if inline is not None:
        out.append(ScopedTree(tree(inline), "", True))
    return AdmissionRules(tuple(out))


def path(virtual: str) -> PathSpec:
    """A resolved path as the classifier gives one.

    Args:
        virtual (str): the absolute virtual path.
    """
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=virtual,
        resolved=True,
        raw_path=virtual,
    )


def line(
    *words: str,
    cwd: str = "/",
    registry: MountRegistry | None = None,
    tool: bool = True,
    session_id: str = "",
) -> CommandContext:
    """A line's context as admission builds it: read once by its
    command's grammar, every word starting with ``/`` a path.

    Args:
        *words (str): the command name and its words.
        cwd (str): where the line runs.
        registry (MountRegistry | None): the mounts and CLIs whose trees
            read the line; None for the built-in commands only.
        tool (bool): False for a shell function's call.
        session_id (str): the session the line runs in.
    """
    name, argv = words[0], list(words[1:])
    classified: list[str | PathSpec] = [
        path(w) if w.startswith("/") else w for w in argv
    ]
    reading = read_line(
        registry or MountRegistry(), name, argv, classified, cwd
    )
    facts = line_facts(name, [name, *classified], cwd)
    return CommandContext(
        command=name,
        paths=tuple(w.path for w in reading.words if w.path is not None),
        words=reading.words,
        argv=tuple(argv),
        cwd=cwd,
        session_id=session_id,
        tokens=reading.tokens,
        program=reading.program,
        read=reading.read,
        tool=tool,
        walks=facts.walks,
        subtree=facts.subtree,
        move_target=facts.move_target,
    )
