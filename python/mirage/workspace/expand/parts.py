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

from collections.abc import Callable
from typing import Any

from mirage.doors.types import SessionView
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import SET_OPTION_DEFAULTS
from mirage.shell.escapes import unescape_unquoted
from mirage.shell.helpers import get_text
from mirage.shell.types import TSNodeLike
from mirage.types import PathSpec
from mirage.utils.glob_walk import mark_escaped_globs
from mirage.utils.path import expand_tilde
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.expand.brace import (
    expand_template,
    make_inert,
    substitute,
)
from mirage.workspace.expand.classify import classify_word
from mirage.workspace.expand.constants import (
    BRACE_LITERAL_TYPES,
    BRACE_WORD_TYPES,
)
from mirage.workspace.expand.fields import split_fields
from mirage.workspace.expand.node import expand_chunks
from mirage.workspace.expand.types import Chunk
from mirage.workspace.expand.variable import ifs_value
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session.shell_dirs import home_dir


async def _expand_brace_word(
    node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None = None,
) -> list[list[Chunk]] | None:
    """Brace-expand a concatenation or brace_expression into words.

    Literal word tokens form the brace template; every other child
    (expansions, strings, substitutions) expands first and joins as an
    inert atom, so `{a,$v}` alternates on the expanded value while
    `{1..$n}` stays literal, matching bash's brace-before-parameter
    ordering. Deliberate divergence: bash rewrites `$v{a,b}` to
    `$va $vb` before parameter expansion; here the prefix keeps its
    own expansion (`prea preb`), which is the useful reading.

    Quoting rides along per character: an atom keeps whatever marks its
    own expansion produced, and the template's escapes are marked
    before quote removal drops them, so `{'*',x}` stays literal while
    `{$p,x}` keeps the value live. Each word keeps its atoms' pieces,
    so an unquoted value still splits: `{a,b}$x` is `a$x b$x`.

    Args:
        node (TSNodeLike): concatenation or brace_expression.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    session = context.session
    pieces: list[str] = []
    atoms: list[TSNodeLike] = []
    for child in node.children:
        if not child.is_named or child.type in BRACE_LITERAL_TYPES:
            pieces.append(get_text(child))
        else:
            atoms.append(child)
            pieces.append(make_inert(len(atoms) - 1))
    words = expand_template("".join(pieces))
    if words is None:
        return None
    values = [
        await expand_chunks(atom, context, execute_fn, call_stack, view=view)
        for atom in atoms
    ]
    home = home_dir(session)
    return [
        substitute(
            expand_tilde(unescape_unquoted(mark_escaped_globs(w)), home),
            values,
        )
        for w in words
    ]


async def expand_words(
    parts: list[Any],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> list[str]:
    """Expand tree-sitter child nodes to words that still know their quoting.

    Each node expands to its pieces, which IFS then splits into fields,
    so an unquoted expansion anywhere in a word splits (``q$x`` too) and
    quoted text never does. A glob character quoting made literal
    travels under its own mark, so `"/data/"*.txt` still globs while
    `'/data/*'.txt` does not and `'/data/*'?.txt` globs on the `?` alone;
    ``unmark_globs`` takes the marks off.

    Args:
        parts (list[Any]): the word nodes to expand.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    session = context.session
    ifs = ifs_value(session, call_stack)
    result: list[str] = []
    for p in parts:
        # The default comes from the option table, not a literal here:
        # two spellings of "brace expansion is on unless told otherwise"
        # is one to drift.
        if p.type in BRACE_WORD_TYPES and session.shell_options.get(
            "braceexpand", SET_OPTION_DEFAULTS["braceexpand"]
        ):
            brace_words = await _expand_brace_word(
                p, context, execute_fn, call_stack, view=view
            )
            if brace_words is not None:
                for chunks in brace_words:
                    result.extend(split_fields(chunks, ifs))
                continue
        chunks = await expand_chunks(
            p, context, execute_fn, call_stack, view=view
        )
        result.extend(split_fields(chunks, ifs))
    return result


async def expand_and_classify(
    words: list[Any],
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    cwd: str,
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> list[str | PathSpec]:
    """Expand words, classify as PathSpec or text.

    Used by for/select where concrete values are needed before
    iteration. Words keep their glob marks, because the loop list is
    glob-resolved next (``resolve_globs``, which is where the marks come
    off): `for f in '/data/*.txt'` iterates once over the name as typed,
    like bash, while `for f in '/data/*'?.txt` still globs on the `?`.
    """
    expanded = await expand_words(
        words, context, execute_fn, call_stack, view=view
    )
    return [classify_word(w, registry, cwd) for w in expanded]
