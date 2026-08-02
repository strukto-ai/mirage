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

if TYPE_CHECKING:
    from mirage.commands.cli.types import CLISpec


def validate_cli(node: "CLISpec") -> None:
    """Validate one CLISpec node at construction time.

    Called from CLISpec.__post_init__, so a structurally invalid node
    raises ValueError at import time, never at dispatch. Children were
    validated by their own construction (a nested literal builds bottom
    up), so each call checks one level: the name is a single word with no
    whitespace, a node takes fn or subcommands (never both, never
    neither), a group declares no positional/rest (its operand is the
    subcommand word), child names are unique, and only a tree's root may
    declare config_model.

    Args:
        node (CLISpec): the freshly constructed node.
    """
    if not node.name or any(ch.isspace() for ch in node.name):
        raise ValueError(
            f"cli name {node.name!r} must be a single non-empty word")
    if node.fn is not None and node.subcommands:
        raise ValueError(
            f"cli {node.name!r}: a node takes fn or subcommands, not both")
    if node.fn is None and not node.subcommands:
        raise ValueError(f"cli {node.name!r}: a node needs fn or subcommands")
    if node.subcommands and (node.positional or node.rest is not None):
        raise ValueError(
            f"cli {node.name!r}: a group's operand is its subcommand "
            f"word; positional/rest belong on leaves")
    seen: set[str] = set()
    for child in node.subcommands:
        if child.name in seen:
            raise ValueError(f"cli {node.name!r}: duplicate subcommand "
                             f"{child.name!r}")
        seen.add(child.name)
        if child.config_model is not None:
            raise ValueError(
                f"cli {node.name!r}: subcommand {child.name!r} declares "
                f"config_model; only the root of a tree may")
