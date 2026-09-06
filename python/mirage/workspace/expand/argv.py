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
from typing import Any

import tree_sitter

from mirage.commands.spec.types import ValueType
from mirage.ops.types import SessionView
from mirage.policy.match import scopes_paths
from mirage.shell.call_stack import CallStack
from mirage.types import PathSpec, word_text
from mirage.utils.glob_walk import literal_word, mark_globs, unmark_globs
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.expand.parts import expand_words
from mirage.workspace.expand.spec_hints import (spec_for_command,
                                                spec_word_bases,
                                                spec_word_kinds)
from mirage.workspace.lookup import (WordPolicy, end_options_after_program,
                                     lookup, word_policy)
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
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
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    registry: MountRegistry,
    namespace: Namespace | None = None,
    view: SessionView | None = None,
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
        namespace (Namespace | None): addressing authority holding the
            links, so a glob word sees links and nested mount roots the
            way a listing does.
    """
    expanded = await expand_words(parts,
                                  session,
                                  execute_fn,
                                  call_stack,
                                  view=view)
    if not expanded:
        return Argv(name="", args=(), operands=())
    # `set -f` turns pathname expansion off, which is the same word for
    # word as every glob character having been quoted.
    if session.shell_options.get("noglob"):
        expanded = [mark_globs(w) for w in expanded]
    # A command name may span several leading words (git-style, e.g.
    # `gws docs documents get`); the registry says how many.
    consumed = registry.match_command_prefix(expanded)
    name = unmark_globs(" ".join(expanded[:consumed]))

    # Before anything reads the line: an option carrying a program hands
    # the words after it to that program, and POSIX's own `--` is how
    # that handoff is spelled. Only when the interpreter is what runs,
    # though: a shell function of the same name takes the line instead
    # (bash's own rule), and it must receive the words as typed rather
    # than a marker meant for a parser it does not have. `command
    # python3` masks the function for its inner run, which is exactly
    # when the rewrite applies again. A CLI cannot reach here at all,
    # since register_cli refuses a shell builtin's name.
    if name not in session.functions:
        expanded = expanded[:consumed] + end_options_after_program(
            name, expanded[consumed:])

    policy = word_policy(lookup(name, session, registry))
    word_kinds: list[ValueType | None] | None = None
    word_bases: list[str | None] | None = None
    if policy is WordPolicy.MOUNT:
        spec = spec_for_command(name, registry, session.cwd)
        if spec:
            # Before anything reads the line: an option carrying a
            # program hands the words after it to that program, and
            # POSIX's own `--` is how that is said.
            extra: list[ValueType | None] = ["str"] * (consumed - 1)
            word_kinds = extra + spec_word_kinds(spec, expanded[consumed:],
                                                 name)
            bases = spec_word_bases(spec, expanded[consumed:], session.cwd)
            if bases is not None:
                head: list[str | None] = [None] * (consumed - 1)
                word_bases = head + bases

    classified = classify_parts(expanded,
                                registry,
                                session.cwd,
                                word_kinds=word_kinds,
                                word_bases=word_bases)
    # A glob word is resolved by whoever consumes it, exactly once:
    # WordPolicy.SHELL words get matches here; mount commands keep
    # patterns for backend pushdown; unknown names fail without
    # touching backends.
    glob_opts = glob_options(session)
    if (policy is WordPolicy.SHELL or glob_opts.needs_shell
            or scopes_paths(session.commands, name)):
        # A backend's resolve_glob speaks bash's defaults only, so a
        # session that turned on nullglob, failglob or globstar has its
        # mount-command globs expanded here too, and the command receives
        # matches the way it does across a mount boundary. So does a
        # command a path-scoped rule names: the admission gate reads the
        # words before the backend would resolve them, and a pattern
        # that only later matches under the rule's path would pass a
        # gate its matches fail.
        words = await resolve_globs(classified,
                                    registry,
                                    links=namespace,
                                    options=glob_opts)
    else:
        # A pattern still owes its backend a resolution, so it travels
        # marked and the marks come off there; every other word is done
        # with its quoting and reads literally from here on.
        words = [
            item if isinstance(item, PathSpec) and item.pattern else
            literal_word(item) for item in classified
        ]
    # The text view renders words as typed (raw_path): bash hands
    # programs their words unchanged, so `echo sub/file.txt` prints the
    # relative form, not the resolved absolute path. Quote removal is
    # part of "as typed": a word never reaches a command marked.
    text_view = [unmark_globs(word_text(p)) for p in words]
    return Argv(name=name,
                args=tuple(text_view[consumed:]),
                operands=tuple(words[consumed:]))
