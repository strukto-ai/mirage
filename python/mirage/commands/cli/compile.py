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

from typing import TYPE_CHECKING

from mirage.commands.spec.compile import compile_spec

if TYPE_CHECKING:
    from mirage.commands.cli.types import CLISpec


def validate_cli(node: "CLISpec") -> None:
    """Validate one CLISpec node at construction time.

    Called from CLISpec.__post_init__, so a structurally invalid node
    raises ValueError at import time, never at dispatch. Children were
    validated by their own construction (a nested literal builds bottom
    up), so each call checks one level: the name is a single word with no
    whitespace, a node takes exactly one of fn, subcommands, or script
    (a script root stands alone: the program re-parses argv natively),
    runtime only rides a script, a group declares no positional/rest
    (its operand is the subcommand word), child names are unique, and
    only a tree's root may declare config_model or script.

    Args:
        node (CLISpec): the freshly constructed node.
    """
    if not node.name or any(ch.isspace() for ch in node.name):
        raise ValueError(
            f"cli name {node.name!r} must be a single non-empty word")
    for alias in node.aliases:
        if not alias or any(ch.isspace() for ch in alias):
            raise ValueError(f"cli {node.name!r}: alias {alias!r} must be "
                             f"a single non-empty word")
    if node.script is not None and node.fn is not None:
        raise ValueError(
            f"cli {node.name!r}: a node takes fn or script, not both")
    if node.script is not None and node.subcommands:
        raise ValueError(
            f"cli {node.name!r}: a script serves the whole program; "
            f"subcommands belong to fn trees")
    if node.runtime is not None and node.script is None:
        raise ValueError(f"cli {node.name!r}: runtime names the entry that "
                         f"runs script; it takes script")
    if node.fn is not None and node.subcommands:
        raise ValueError(
            f"cli {node.name!r}: a node takes fn or subcommands, not both")
    if node.fn is None and not node.subcommands and node.script is None:
        raise ValueError(
            f"cli {node.name!r}: a node needs fn, subcommands, or script")
    if node.subcommands and (node.positional or node.rest is not None):
        raise ValueError(
            f"cli {node.name!r}: a group's operand is its subcommand "
            f"word; positional/rest belong on leaves")
    # Names and aliases share one sibling namespace (argparse refuses a
    # conflicting subparser alias the same way).
    seen: set[str] = set()
    for child in node.subcommands:
        for word in (child.name, ) + child.aliases:
            if word in seen:
                raise ValueError(f"cli {node.name!r}: duplicate subcommand "
                                 f"{word!r}")
            seen.add(word)
        if child.config_model is not None:
            raise ValueError(
                f"cli {node.name!r}: subcommand {child.name!r} declares "
                f"config_model; only the root of a tree may")
        if child.script is not None:
            raise ValueError(
                f"cli {node.name!r}: subcommand {child.name!r} declares "
                f"script; only the root of a tree may")
    if node.options and node.subcommands:
        own = set(compile_spec(node).dest.values())
        for child in node.subcommands:
            _check_collisions(node.name, own, child, (child.name, ))


def _check_collisions(root_name: str, ancestor_dests: set[str],
                      node: "CLISpec", path: tuple[str, ...]) -> None:
    """Refuse an option spelled the same on a node and any descendant.

    The walk consumes group options level by level into one flag bag, so
    an ancestor/descendant collision would be ambiguous there; siblings
    may freely share spellings. Children validated themselves already,
    so this only compares each descendant against the ancestor set.

    Args:
        root_name (str): the ancestor node's name, for the message.
        ancestor_dests (set[str]): canonical spellings on the ancestor.
        node (CLISpec): descendant being checked.
        path (tuple[str, ...]): words from the ancestor to ``node``.
    """
    if node.options:
        for dest in compile_spec(node).dest.values():
            if dest in ancestor_dests:
                raise ValueError(
                    f"cli {root_name!r}: option '{dest}' collides with "
                    f"subcommand {' '.join(path)!r}")
    for child in node.subcommands:
        _check_collisions(root_name, ancestor_dests, child,
                          path + (child.name, ))
