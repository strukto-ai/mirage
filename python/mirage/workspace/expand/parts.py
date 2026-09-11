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
from functools import partial
from typing import Any

import tree_sitter

from mirage.ops.types import SessionView
from mirage.shell.call_stack import CallStack
from mirage.shell.constants import SET_OPTION_DEFAULTS
from mirage.shell.escapes import unescape_unquoted
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.types import PathSpec
from mirage.utils.glob_walk import mark_escaped_globs, mark_globs, unmark_globs
from mirage.utils.path import expand_tilde
from mirage.workspace.expand.brace import (expand_template, make_inert,
                                           substitute)
from mirage.workspace.expand.classify import classify_word
from mirage.workspace.expand.constants import (BRACE_LITERAL_TYPES,
                                               BRACE_WORD_TYPES, SPLIT_TYPES)
from mirage.workspace.expand.node import (_folded_whitespace, expand_node,
                                          expand_node_marked)
from mirage.workspace.expand.variable import expand_array_at, is_multiword_at
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir


def _string_has_array_at(node: tree_sitter.Node) -> bool:
    return any(is_multiword_at(c) for c in node.children)


async def _expand_string_with_array(
    node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None = None,
) -> list[str]:
    """Expand a string containing one or more "${a[@]...}" into words.

    Bash semantics: "prefix${a[@]}suffix" with a=(1 2 3) produces three
    words: "prefix1", "2", "3suffix". Slices ("${a[@]:o:l}"), per-element
    ops ("${a[@]/x/y}"), and indices ("${!a[@]}") word-split the same
    way. A single-element result merges prefix and suffix into one word;
    an empty result still yields prefix+suffix.
    """
    expand_child = partial(expand_node,
                           session=session,
                           execute_fn=execute_fn,
                           call_stack=call_stack)
    fragments: list[str] = [""]
    splat_yielded = False
    for child in node.children:
        if child.type == NT.DQUOTE:
            continue
        if is_multiword_at(child):
            words = await expand_array_at(child,
                                          session,
                                          call_stack,
                                          expand_child,
                                          view=view)
            # The separating whitespace is folded into this node, and
            # survives even when the array is empty: bash renders
            # "$x ${empty[@]}" as the single word "a ".
            fragments[-1] = fragments[-1] + _folded_whitespace(child)
            if not words:
                continue
            splat_yielded = True
            if len(words) == 1:
                fragments[-1] = fragments[-1] + words[0]
            else:
                fragments[-1] = fragments[-1] + words[0]
                fragments.extend(words[1:-1])
                fragments.append(words[-1])
            continue
        text = await expand_node(child,
                                 session,
                                 execute_fn,
                                 call_stack,
                                 view=view)
        fragments[-1] = fragments[-1] + text
    if fragments == [""] and not splat_yielded:
        # A splat that yielded nothing, with no text around it, is no word
        # at all. One empty ELEMENT is a word though (set -- "" passes one
        # empty argument), so the rendered text cannot decide this; only
        # the element count can. An empty expansion beside it does not
        # rescue the word either: with no parameters, "$u$@" is nothing.
        return []
    # Every fragment came from inside the quotes, so its glob characters
    # are literal.
    return [mark_globs(f) for f in fragments]


async def _expand_brace_word(
    node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None,
    view: SessionView | None = None,
) -> list[str] | None:
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
    `{$p,x}` keeps the value live.

    Args:
        node (tree_sitter.Node): concatenation or brace_expression.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    pieces: list[str] = []
    values: list[str] = []
    for child in node.children:
        if not child.is_named or child.type in BRACE_LITERAL_TYPES:
            pieces.append(get_text(child))
        else:
            values.append(await expand_node_marked(child,
                                                   session,
                                                   execute_fn,
                                                   call_stack,
                                                   view=view))
            pieces.append(make_inert(len(values) - 1))
    words = expand_template("".join(pieces))
    if words is None:
        return None
    home = home_dir(session)
    return [
        substitute(
            expand_tilde(unescape_unquoted(mark_escaped_globs(w)), home),
            values) for w in words
    ]


async def expand_words(
    parts: list[Any],
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
    view: SessionView | None = None,
) -> list[str]:
    """Expand tree-sitter child nodes to words that still know their quoting.

    The words are exactly expand_parts', except that a glob character
    quoting made literal travels under its own mark, so
    `"/data/"*.txt` still globs while `'/data/*'.txt` does not and
    `'/data/*'?.txt` globs on the `?` alone. Only pathname expansion
    reads these; everything else takes the unmarked ``expand_parts``.

    Args:
        parts (list[Any]): the word nodes to expand.
        session (Session): shell session state.
        execute_fn (Callable): evaluator for command substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    result: list[str] = []
    for p in parts:
        if p.type == NT.STRING and _string_has_array_at(p):
            words = await _expand_string_with_array(p,
                                                    session,
                                                    execute_fn,
                                                    call_stack,
                                                    view=view)
            result.extend(words)
            continue
        # The default comes from the option table, not a literal here:
        # two spellings of "brace expansion is on unless told otherwise"
        # is one to drift.
        if (p.type in BRACE_WORD_TYPES and session.shell_options.get(
                "braceexpand", SET_OPTION_DEFAULTS["braceexpand"])):
            brace_words = await _expand_brace_word(p,
                                                   session,
                                                   execute_fn,
                                                   call_stack,
                                                   view=view)
            if brace_words is not None:
                # Empty unquoted words vanish, like bash: {,x} -> x.
                result.extend(w for w in brace_words if w)
                continue
        expanded = await expand_node_marked(p,
                                            session,
                                            execute_fn,
                                            call_stack,
                                            view=view)
        if p.type == NT.COMMAND_SUBSTITUTION:
            for word in expanded.split():
                if word:
                    result.append(word)
            continue
        elif p.type in SPLIT_TYPES:
            for word in expanded.split():
                if word:
                    result.append(word)
        elif p.type == NT.STRING:
            # A quoted word stays a word even when it expands to "" (echo
            # "" or "$EMPTY"). The splats that yield zero words instead
            # ("$@", "${a[@]}") never reach here; they took the branch
            # above.
            result.append(expanded)
        elif p.type in (NT.RAW_STRING, NT.ANSI_C_STRING, NT.TRANSLATED_STRING):
            result.append(expanded)
        else:
            if expanded:
                result.append(expanded)
    return result


async def expand_parts(
    parts: list[Any],
    session: Session,
    execute_fn: Callable[..., Any],
    call_stack: CallStack | None = None,
) -> list[str]:
    """Expand a list of tree-sitter child nodes to strings."""
    words = await expand_words(parts, session, execute_fn, call_stack)
    return [unmark_globs(w) for w in words]


async def expand_and_classify(
    words: list[Any],
    session: Session,
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
    expanded = await expand_words(words,
                                  session,
                                  execute_fn,
                                  call_stack,
                                  view=view)
    return [classify_word(w, registry, cwd) for w in expanded]
