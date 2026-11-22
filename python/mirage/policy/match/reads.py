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

from mirage.policy.types import AdmissionRules, Outcome, ScopedTree
from mirage.rs.document import units
from mirage.rs.policy import admission_matcher


def has_rules(rules: AdmissionRules | None) -> bool:
    """Whether the profile states any command tree at all.

    Args:
        rules (AdmissionRules | None): the session's command trees.
    """
    return rules is not None and bool(rules.trees)


def _root_denies(scoped: ScopedTree) -> bool:
    return not scoped.mount and any(
        leaf.decision is Outcome.DENY for leaf in scoped.tree.decision
    )


def closed_by_default(rules: AdmissionRules | None) -> bool:
    """Whether a top-level tree denies each line it names no command
    for: its root's own decision is a deny.

    Args:
        rules (AdmissionRules | None): the session's command trees.
    """
    return rules is not None and any(map(_root_denies, rules.trees))


def closed(rules: AdmissionRules | None) -> bool:
    """Whether a top-level tree denies every line: closed by default
    (``closed_by_default``) and naming no command.

    Args:
        rules (AdmissionRules | None): the session's command trees.
    """
    return rules is not None and any(
        _root_denies(scoped)
        and not scoped.tree.subcommands
        and not scoped.tree.operands
        for scoped in rules.trees
    )


def reads_args(rules: AdmissionRules | None, name: str) -> bool:
    """Whether a tree in force reads a command's words past its name.

    The whole-line gate asks this for a word the runtime, not the gate,
    will expand: the head of every command is read by every tree, but an
    argument only matters to a node below the command (a subcommand, an
    option, an operand) or a folder entry's tree, so a
    dynamic argument to a command no such node names is nothing a tree
    would have seen anyway.

    Args:
        rules (AdmissionRules | None): the session's command trees.
        name (str): the command name, as typed.
    """
    return (
        rules is not None
        and admission_matcher(rules).ask("reads_args", name=units(name))
        is True
    )


def scopes_paths(rules: AdmissionRules | None, name: str) -> bool:
    """Whether a folder entry's tree in force reads this command's
    paths.

    The argv builder asks this before deciding who resolves a glob
    operand: a mount command's pattern is normally pushed down to the
    backend, so the gate would see the pattern, not the matches, and
    ``cat /scratch/*/k`` would pass a folder entry for
    ``/scratch/private`` that ``cat /scratch/private/k`` fails. When a
    folder entry's tree speaks for the command, whether it names the
    command or every command, the shell expands the glob first, so the
    gate judges the paths the command will touch.

    Args:
        rules (AdmissionRules | None): the session's command trees.
        name (str): the command name, as typed.
    """
    return (
        rules is not None
        and admission_matcher(rules).ask("scopes_paths", name=units(name))
        is True
    )
