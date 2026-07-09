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

import dataclasses
from collections.abc import Callable, Iterable
from dataclasses import dataclass

import tree_sitter

from mirage.commands.spec.types import OperandKind
from mirage.shell.call_stack import CallStack
from mirage.types import PathSpec
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.expand.globs import resolve_globs
from mirage.workspace.expand.parts import expand_parts
from mirage.workspace.expand.spec_hints import (spec_for_command,
                                                spec_word_kinds)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.route import WordPolicy, route, word_policy
from mirage.workspace.session import Session


@dataclass(frozen=True, slots=True)
class Argv:
    """One command's expanded argument vector.

    `expand_argv` is the only place allowed to know that word zero of
    an expanded command is its name; every consumer reads named views
    instead of slicing word lists.

    `args` and `operands` are two views of the same final word list and
    always have equal length; they differ only in element type. Glob
    words are resolved by whoever consumes them, exactly once: shell
    consumers get shell-resolved words in both views, mount commands
    keep pattern PathSpecs for backend pushdown.

    Args:
        name (str): expanded command name.
        args (tuple[str, ...]): text view (what builtins consume).
        operands (tuple[str | PathSpec, ...]): classified view (what
            mount dispatch, test, and ln consume).
    """

    name: str
    args: tuple[str, ...]
    operands: tuple[str | PathSpec, ...]

    @property
    def words(self) -> list[str | PathSpec]:
        """Full classified word list, name included."""
        if not self.name and not self.operands:
            return []
        return [self.name, *self.operands]

    def with_operands(self, operands: Iterable[str | PathSpec]) -> "Argv":
        """Return a copy with the classified view replaced.

        Args:
            operands (Iterable[str | PathSpec]): replacement operands
                (e.g. after symlink rewriting).
        """
        return dataclasses.replace(self, operands=tuple(operands))


async def expand_argv(
    parts: list[tree_sitter.Node],
    session: Session,
    execute_fn: Callable,
    call_stack: CallStack | None,
    registry: MountRegistry,
) -> Argv:
    """Expand, classify, and glob-resolve a command's word nodes.

    Uses the cwd mount's CommandSpec (when it has one for the command)
    to decide which words are TEXT (skip classification) and which are
    PATH (classify even bare filenames).

    Args:
        parts (list[tree_sitter.Node]): word nodes after env-prefix
            stripping and process-substitution removal.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        registry (MountRegistry): mount registry for classification.
    """
    expanded = await expand_parts(parts, session, execute_fn, call_stack)
    if not expanded:
        return Argv(name="", args=(), operands=())
    name = expanded[0]

    policy = word_policy(route(name, session, registry))
    word_kinds: list[OperandKind | None] | None = None
    if policy is WordPolicy.MOUNT:
        spec = spec_for_command(name, registry, session.cwd)
        if spec:
            word_kinds = spec_word_kinds(spec, expanded[1:])

    classified = classify_parts(expanded,
                                registry,
                                session.cwd,
                                word_kinds=word_kinds)
    # A glob word is resolved by whoever consumes it, exactly once:
    # WordPolicy.SHELL words get matches here; mount commands keep
    # patterns for backend pushdown; unknown names fail without
    # touching backends.
    if policy is WordPolicy.SHELL:
        words = await resolve_globs(classified, registry)
    else:
        words = classified
    text_view = [p.virtual if isinstance(p, PathSpec) else p for p in words]
    return Argv(name=name,
                args=tuple(text_view[1:]),
                operands=tuple(words[1:]))
