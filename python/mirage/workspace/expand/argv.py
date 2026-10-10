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

from mirage.commands.spec.types import CommandSpec, ValueType
from mirage.policy.match import scopes_paths
from mirage.runtime.base import Runtime
from mirage.runtime.routing.types import RouteDecision
from mirage.shell.call_stack import CallStack
from mirage.shell.types import TSNodeLike
from mirage.types import PathSpec, word_text
from mirage.utils.glob_walk import (
    has_glob,
    literal_word,
    mark_globs,
    unmark_globs,
)
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.expand.classify import classify_parts
from mirage.workspace.expand.globs import glob_options, resolve_globs
from mirage.workspace.expand.parts import expand_words
from mirage.workspace.expand.spec_hints import (
    spec_for_command,
    spec_word_bases,
    spec_word_kinds,
)
from mirage.workspace.lookup import (
    Consumer,
    WordPolicy,
    end_options_after_program,
    lookup,
    runtime_refused,
    word_policy,
)
from mirage.workspace.lookup.constants import INTERPRETER_NAMES
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace


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
        prefix (tuple[str, ...]): original words forming the matched name.
    """

    name: str
    args: tuple[str, ...]
    operands: tuple[str | PathSpec, ...]
    prefix: tuple[str, ...] = ()

    @property
    def tokens(self) -> tuple[str, ...]:
        """Native argv, preserving word boundaries within a matched name."""
        return (*(self.prefix or (self.name,)), *self.args)

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
    parts: list[TSNodeLike],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    registry: MountRegistry,
    namespace: Namespace | None = None,
    view: SessionView | None = None,
    routing: RouteDecision[Runtime] | None = None,
) -> Argv:
    """Expand, classify, and glob-resolve a command's word nodes.

    Uses the cwd mount's CommandSpec (when it has one for the command)
    to decide which words are TEXT (skip classification) and which are
    PATH (classify even bare filenames). A program's line (a native
    capture, or an interpreter run in-process) is globbed whatever the
    slots, as bash globs it, and its words are then classified for the
    slots the expanded words fill.

    Args:
        parts (list[TSNodeLike]): word nodes after env-prefix stripping.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
        registry (MountRegistry): mount registry for classification.
        namespace (Namespace | None): addressing authority holding the
            links, so a glob word sees links and nested mount roots the
            way a listing does.
    """
    session = context.session
    expanded = await expand_words(
        parts, context, execute_fn, call_stack, view=view
    )
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
    consumer = lookup(name, session, registry, routing)
    refused = runtime_refused(name, session, registry, routing)
    if name not in session.functions and consumer is not Consumer.EXTERNAL:
        expanded = expanded[:consumed] + end_options_after_program(
            name, expanded[consumed:]
        )

    policy = word_policy(consumer)
    # A native program gets its words the way bash hands them over, with
    # every unquoted glob already expanded, whatever slot the word fills.
    native = consumer is Consumer.EXTERNAL and not refused
    # So does an interpreter run in-process. The words after its program
    # are that program's argv, handed over as typed, and only its script
    # is a file it opens: the spec's script slot makes that one word a
    # path, so a rule protecting `secret.py` reads `python3 secret.py`
    # however the script is spelled, while `python3 s.py data/in.csv`
    # hands the script `data/in.csv` and a `/tmp/q.txt` beside a script
    # on /workspace names no second mount.
    in_process = consumer is Consumer.SESSION and name in INTERPRETER_NAMES
    program = native or in_process
    spec: CommandSpec | None = None
    word_kinds: list[ValueType | None] | None = None
    word_bases: list[str | None] | None = None
    # Native captures and interpreters still need the spec's path roles
    # for admission.
    if (
        policy is WordPolicy.MOUNT
        or consumer is Consumer.EXTERNAL
        or in_process
    ):
        spec = spec_for_command(name, registry, session.cwd)
        if spec:
            # Before anything reads the line: an option carrying a
            # program hands the words after it to that program, and
            # POSIX's own `--` is how that is said.
            extra: list[ValueType | None] = ["str"] * (consumed - 1)
            word_kinds = extra + spec_word_kinds(
                spec, expanded[consumed:], name
            )
            bases = spec_word_bases(spec, expanded[consumed:], session.cwd)
            if bases is not None:
                head: list[str | None] = [None] * (consumed - 1)
                word_bases = head + bases
    if program:
        # bash globs every unquoted word before the program reads any of
        # them, whatever slot it fills and whatever it looks like:
        # `python3 s.py *.txt` gets the matches, `.*.txt` the dotfiles and
        # `x=*` a file named `x=1`, and a glob that matches nothing stays
        # the word as typed. So a word carrying a live glob character is a
        # pattern here, spec or no spec, rather than a shell word the
        # shape rules read. A quoted one carries marks rather than glob
        # characters, so it stays text.
        tail = expanded[consumed:]
        own = (
            word_kinds[consumed - 1 :]
            if word_kinds is not None
            else [None] * len(tail)
        )
        names: list[ValueType | None] = ["str"] * (consumed - 1)
        globbed: list[ValueType | None] = [
            "path" if has_glob(word) else kind for kind, word in zip(own, tail)
        ]
        word_kinds = names + globbed

    classified = classify_parts(
        expanded,
        registry,
        session.cwd,
        word_kinds=word_kinds,
        word_bases=word_bases,
    )
    # A glob word is resolved by whoever consumes it, exactly once:
    # WordPolicy.SHELL words get matches here; mount commands keep
    # patterns for backend pushdown; unknown names fail without
    # touching backends.
    glob_opts = glob_options(session)
    if not refused and (
        policy is WordPolicy.SHELL
        or glob_opts.needs_shell
        or scopes_paths(session.commands, name)
        or any(
            isinstance(w, PathSpec) and w.pattern and w.dotted
            for w in classified
        )
    ):
        # A backend's resolve_glob speaks bash's defaults only, so a
        # session that turned on nullglob, failglob or globstar has its
        # mount-command globs expanded here too, and the command receives
        # matches the way it does across a mount boundary. So does a
        # command a path-scoped rule names: the admission gate reads the
        # words before the backend would resolve them, and a pattern
        # that only later matches under the rule's path would pass a
        # gate its matches fail. And so does a pattern that walks a `.`
        # or `..`, which no backend key holds.
        words = await resolve_globs(
            classified, registry, links=namespace, options=glob_opts
        )
    else:
        # A pattern still owes its backend a resolution, so it travels
        # marked and the marks come off there; every other word is done
        # with its quoting and reads literally from here on.
        words = [
            item
            if isinstance(item, PathSpec) and item.pattern
            else literal_word(item)
            for item in classified
        ]
    if program and spec:
        words = _program_words(
            words, spec, name, consumed, registry, session.cwd
        )
    # The text view renders words as typed (raw_path): bash hands
    # programs their words unchanged, so `echo sub/file.txt` prints the
    # relative form, not the resolved absolute path. Quote removal is
    # part of "as typed": a word never reaches a command marked.
    text_view = [unmark_globs(word_text(p)) for p in words]
    return Argv(
        name=name,
        args=tuple(text_view[consumed:]),
        operands=tuple(words[consumed:]),
        prefix=tuple(unmark_globs(word) for word in expanded[:consumed]),
    )


def _program_words(
    words: list[str | PathSpec],
    spec: CommandSpec,
    name: str,
    consumed: int,
    registry: MountRegistry,
    cwd: str,
) -> list[str | PathSpec]:
    """Classify a program's words for the argv it receives.

    bash expands every glob before the program parses its argv, so a
    match can fill a slot of another kind than the word it came from:
    `grep *.txt` hands grep its pattern and its files out of one word,
    and a glob's extra matches push every later word into a later slot.
    The spec therefore reads the expanded words, which are literal from
    here on, and each word is classified for the slot it now fills.
    Admission then judges the paths the program opens, and a match in a
    text slot is text, exactly like the same word typed by hand. A glob
    that matched nothing keeps the pattern spec the resolver left in a
    path slot, and is its typed text in a text slot.

    Args:
        words (list[str | PathSpec]): the resolved words, name first.
        spec (CommandSpec): the program's command spec.
        name (str): the expanded command name.
        consumed (int): how many leading words form the name.
        registry (MountRegistry): mount registry for classification.
        cwd (str): working directory the line was typed under.
    """
    literal = [mark_globs(word_text(w)) for w in words]
    kinds: list[ValueType | None] = ["str"] * (consumed - 1)
    kinds += spec_word_kinds(spec, literal[consumed:], name)
    bases = spec_word_bases(spec, literal[consumed:], cwd)
    head: list[str | None] = [None] * (consumed - 1)
    reread = classify_parts(
        literal,
        registry,
        cwd,
        word_kinds=kinds,
        word_bases=None if bases is None else head + bases,
    )
    out: list[str | PathSpec] = [words[0]]
    for word, kind, fresh in zip(words[1:], kinds, reread[1:]):
        if not (isinstance(word, PathSpec) and word.pattern):
            out.append(literal_word(fresh))
        elif kind in (None, "path"):
            out.append(word)
        else:
            out.append(literal_word(word_text(word)))
    return out
