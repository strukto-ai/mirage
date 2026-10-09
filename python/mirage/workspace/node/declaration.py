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

from typing import Any, Callable

from mirage.io import IOResult
from mirage.policy import PolicyDenied
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import DiscardSignal
from mirage.shell.helpers import get_declaration_keyword, get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import VarAttr, VarKind
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins import (
    handle_declare_functions,
    handle_declare_print,
    handle_export,
    handle_local,
    handle_readonly,
    note_local_array,
)
from mirage.workspace.executor.builtins.declare.constants import (
    LISTED_ATTRIBUTES,
    VISIBLE_SCOPE_BUILTINS,
)
from mirage.workspace.executor.builtins.declare.declare import (
    declared_kind,
    held_value,
    kind_conflict,
    start_local,
)
from mirage.workspace.executor.builtins.declare.types import (
    AttrMarks,
    DeclarationOperand,
)
from mirage.workspace.expand import expand_node
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.assignment import expand_array_items
from mirage.workspace.session.state import (
    conversion_scalar,
    ensure_var_visible,
    seed_var,
    session_view,
)
from mirage.workspace.types import ExecutionNode


def _merge_conversion_errors(
    result: tuple[Any, IOResult, ExecutionNode],
    errors: list[str],
) -> tuple[Any, IOResult, ExecutionNode]:
    """Fold kind-conversion refusals into a declaration's result.

    GNU reports `cannot convert indexed to associative array` per
    refused name on stderr and fails the builtin with 1 while the other
    operands still declare, so the refusals ride the handler's own
    result rather than replacing it.

    Args:
        result (tuple): the handler's (stream, io, node) answer.
        errors (list[str]): the refusal lines, in operand order.
    """
    if not errors:
        return result
    stream, io, node = result
    extra = encode_text("\n".join(errors) + "\n")
    prior = io.stderr if isinstance(io.stderr, bytes) else b""
    merged = prior + extra
    new_io = IOResult(
        exit_code=1,
        stderr=merged,
        reads=io.reads,
        writes=io.writes,
        cache=io.cache,
    )
    new_node = ExecutionNode(command=node.command, exit_code=1, stderr=merged)
    return stream, new_io, new_node


# Every letter GNU's `declare` accepts, so a typo refuses with the usage
# line instead of being silently dropped. `-a`/`-A` are kinds, not
# attributes, and are handled by the array branch; `-p`/`-f`/`-F`/`-g`
# /`-I` are modes the handlers read. `-n` stores the reference and every
# reader and writer resolves through it (`deref` in `session/state`).
_DECLARE_LETTERS = frozenset("aAfFgiIlnprtux")
_DECLARE_USAGE = (
    "declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] "
    "or declare -p [-aAfFilnrtux] [name ...]"
)
# The stored attributes a `-letter` / `+letter` toggles.
_ATTR_LETTERS = {
    "i": VarAttr.INTEGER,
    "l": VarAttr.LOWER,
    "u": VarAttr.UPPER,
    "n": VarAttr.NAMEREF,
    "t": VarAttr.TRACE,
    "x": VarAttr.EXPORT,
    "r": VarAttr.READONLY,
}
# `-l` displaces `-u` and vice versa; the record keeps one.
_DISPLACES = {"l": VarAttr.UPPER, "u": VarAttr.LOWER}
# The attributes that shape a value as it stores.
_SHAPING = frozenset({VarAttr.INTEGER, VarAttr.LOWER, VarAttr.UPPER})


def _declare_option_refusal(
    cmd: str,
    flag_chars: set[str],
    plus_chars: set[str],
    context: EvaluationContext,
) -> tuple[Any, IOResult, ExecutionNode] | None:
    """The refusal a `declare` family option cluster earns, if any.

    An unknown letter is GNU's `invalid option` plus the usage line,
    exit 2, and it wins over every other check because bash refuses
    the cluster before it looks at a single operand.

    Args:
        cmd (str): the builtin's own name for the diagnostic.
        flag_chars (set[str]): the `-` letters, `--` excluded.
        plus_chars (set[str]): the `+` letters.
        context (EvaluationContext): the evaluation (unused today, kept so
            a later check that reads it does not change the signature).
    """
    bad = next(
        (
            c
            for c in sorted(flag_chars | plus_chars)
            if c not in _DECLARE_LETTERS
        ),
        None,
    )
    if bad is None:
        return None
    sign = "-" if bad in flag_chars else "+"
    err = encode_text(
        f"bash: {cmd}: {sign}{bad}: invalid option\n{_DECLARE_USAGE}\n"
    )
    return (
        None,
        IOResult(exit_code=2, stderr=err),
        ExecutionNode(command=cmd, exit_code=2, stderr=err),
    )


def _declared_marks(flag_chars: set[str], plus_chars: set[str]) -> AttrMarks:
    """The attribute marks a declaration puts on each operand once it
    lands, in order, readonly last.

    The letters that shape a value (`-i -l -u`) are stored as
    attributes and applied by the session view on every *later* write, which is
    GNU's rule: `v=MiXeD; declare -l v` keeps `MiXeD`, and the next
    `v=ABC` stores `abc`. So this marks and never rewrites. `-l` and
    `-u` are exclusive: setting one clears the other, and a cluster
    naming both (`-lu`, `-ul`) sets neither, both pinned on 5.2.37. A
    `+` letter clears; `+r` is not an off toggle, since it is refused on
    a readonly name (`plus_refusal`) and a no-op otherwise. `r` lands
    last, as each operand's own last step: `declare -rl L=ABC L=DEF`
    keeps `abc` and refuses the second write.

    Args:
        flag_chars (set[str]): the `-` letters.
        plus_chars (set[str]): the `+` letters.
    """
    on = {c for c in "iluntxr" if c in flag_chars and c not in plus_chars}
    if {"l", "u"} <= on:
        on -= {"l", "u"}
    marks: list[tuple[VarAttr, bool]] = []
    for c in "xiluntr":
        if c in on:
            marks.append((_ATTR_LETTERS[c], True))
            if c in _DISPLACES:
                marks.append((_DISPLACES[c], False))
        elif c in plus_chars and c != "r":
            marks.append((_ATTR_LETTERS[c], False))
    return tuple(marks)


async def execute_declaration(
    node: Any,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
    view: SessionView,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Execute one declaration statement (export/local/declare/readonly).

    The executor only reads the operands: it expands them and sorts out
    the option letters, keeping the words and the staged array literals
    in the order typed, then hands them to the builtin handler that owns
    the keyword, which marks each operand with the attribute letters
    (`-x`, `-i`, `-l`) at its place, so `declare -rx X=1` keeps both
    marks.

    Args:
        node (Any): the tree-sitter ``declaration_command`` node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): recursive execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
        view (SessionView): the gated session view, bound once
            for the line so a pre_session rule governs an
            expansion-time write exactly as it governs `X=d`.
    """
    session = context.session
    keyword = get_declaration_keyword(node)
    # Array literals are staged, not stored: `readonly -a a=(y)` on an
    # already-readonly name has to fail with the old value intact. They
    # keep their place among the words, since bash marks each name in
    # the order typed.
    operands: list[DeclarationOperand] = []
    # Option words are kept verbatim, in order, so `--` survives as an
    # end-of-options marker and the handlers can name the *first* bad
    # option letter the way bash does.
    flag_words: list[str] = []
    flag_chars: set[str] = set()
    plus_chars: set[str] = set()
    opts_done = False
    for child in node.named_children:
        if child.type == NT.VARIABLE_ASSIGNMENT:
            val_nodes = [
                c for c in child.named_children if c.type != NT.VARIABLE_NAME
            ]
            if val_nodes and val_nodes[0].type == NT.ARRAY:
                key = get_text(child).partition("=")[0]
                items = await expand_array_items(
                    val_nodes[0], context, execute_fn, registry, namespace, cs
                )
                operands.append(
                    (key.removesuffix("+"), key.endswith("+"), items)
                )
                continue
            expanded = await expand_node(
                child, context, execute_fn, cs, view=view
            )
            operands.append(expanded)
        elif child.type in (
            NT.SIMPLE_EXPANSION,
            NT.EXPANSION,
            NT.CONCATENATION,
            NT.WORD,
            NT.VARIABLE_NAME,
            NT.STRING,
            NT.RAW_STRING,
            NT.ANSI_C_STRING,
            NT.TRANSLATED_STRING,
        ):
            # A bare `readonly NAME` / `export NAME` operand parses as
            # a variable_name, not a word, and a quoted assignment
            # (`export 'FOO=bar'`) as a plain string operand.
            expanded = await expand_node(
                child, context, execute_fn, cs, view=view
            )
            if not expanded and child.type in (
                NT.SIMPLE_EXPANSION,
                NT.EXPANSION,
            ):
                # An *unquoted* expansion that came back empty is
                # removed by word splitting, so `export $UNSET` is a
                # bare `export` and prints the listing. A quoted one
                # is a real, empty operand: GNU answers both
                # `export ""` and `export "$UNSET"` with
                # ``export: `': not a valid identifier``, so it has
                # to reach the builtin rather than vanish here.
                continue
            if (
                not opts_done
                and expanded.startswith("-")
                and len(expanded) > 1
            ):
                flag_words.append(expanded)
                if expanded == "--":
                    opts_done = True
                else:
                    flag_chars.update(expanded[1:])
            elif (
                not opts_done
                and expanded.startswith("+")
                and len(expanded) > 1
                and keyword in (NT.LOCAL, "declare", "typeset")
            ):
                # `+attr` turns an attribute off. Only the declare
                # family reads it: `export +x` and `readonly +r` are
                # `not a valid identifier` in GNU, so for those two
                # the word falls through as an operand and refuses
                # there.
                plus_chars.update(expanded[1:])
            else:
                operands.append(expanded)
    cmd_word = "local" if keyword == NT.LOCAL else str(keyword)
    words = [operand for operand in operands if isinstance(operand, str)]
    if keyword in (NT.LOCAL, "declare", "typeset"):
        refused = _declare_option_refusal(
            cmd_word, flag_chars, plus_chars, context
        )
        if refused is not None:
            return refused
    if ("f" in flag_chars or "F" in flag_chars) and keyword in (
        NT.LOCAL,
        "declare",
        "typeset",
    ):
        # `-f`/`-F` select functions, not variables: `-rf` freezes,
        # `-xf` exports, `-f NAME` prints the body, `-F NAME` prints the
        # name, and a missing name is exit 1 without a word.
        return handle_declare_functions(
            cmd_word, session, flag_chars, words, frozenset(plus_chars)
        )
    # The value-shaping marks go on or off before a value stores, the
    # rest once it has (`_declared_marks`).
    marks = _declared_marks(flag_chars, plus_chars)
    shaping = tuple(mark for mark in marks if mark[0] in _SHAPING)
    # `-p` prints rather than declares, so it is answered before anything
    # declares (`declare -ap NAME` converts nothing); with no names, an
    # attribute letter lists the names carrying it, `-p` or not.
    listing = not operands
    if (
        "p" in flag_chars
        or "p" in plus_chars
        or (listing and flag_chars & (LISTED_ATTRIBUTES | {"a", "A"}))
    ) and keyword in ("declare", "typeset"):
        return await handle_declare_print(words, session, flag_chars)
    conversion_errors: list[str] = []
    kind = declared_kind(flag_chars)
    if kind is not None and keyword not in VISIBLE_SCOPE_BUILTINS:
        # `declare -a NAME` / `declare -A NAME` with no value declare
        # an empty array of that kind, so ${#NAME[@]} is 0 and an
        # element write leaves the other slots unassigned. GNU
        # refuses to convert between the two kinds and says so per
        # name while the rest of the operands still declare. `export`
        # and `readonly` leave a bare name's value alone.
        want_assoc = kind is VarKind.ASSOC
        for bare in words:
            if "=" in bare:
                continue
            # Both branches below write array storage raw (the
            # top-level one migrates an existing scalar), so a
            # hidden name refuses like any assignment spelling
            # before either lands.
            try:
                ensure_var_visible(session, bare)
            except PolicyDenied as exc:
                raise DiscardSignal(encode_text(f"{exc.strerror}\n")) from exc
            fresh = (
                "g" not in flag_chars
                and session._local_vars is not None
                and bare not in session._local_vars
            )
            held_var = session.vars.get(bare)
            if (
                fresh
                and held_var is not None
                and VarAttr.READONLY in held_var.attrs
            ):
                # `handle_local` refuses the readonly name in its voice.
                continue
            # Inside a function the name is a local of the declared kind,
            # a new one starting as `start_local` leaves it (with `-I`,
            # the value it shadows); `-g` declares at global scope.
            local = "g" not in flag_chars and note_local_array(session, bare)
            if local and fresh:
                start_local(session, bare, "I" in flag_chars)
            held = held_value(session, bare)
            conflict = kind_conflict(held, kind)
            if conflict is not None:
                conversion_errors.append(
                    f"bash: {cmd_word}: {bare}: {conflict}"
                )
                continue
            if isinstance(held, dict if want_assoc else list):
                continue
            # A local of another kind starts empty; at top level an
            # existing scalar becomes element 0, or the value at the
            # literal key "0" (GNU allows scalar-to-associative
            # conversion, unlike indexed).
            scalar = None if local else conversion_scalar(session, bare)
            if want_assoc:
                seed_var(
                    session, bare, {} if scalar is None else {"0": scalar}
                )
            else:
                seed_var(session, bare, [] if scalar is None else [scalar])
    # Array literals travel as data: the handler stores them through
    # the session view and owns both refusal voices, so the executor
    # only expands and stages.
    if keyword == "readonly":
        result = await handle_readonly(
            [*flag_words, *operands],
            session,
            session_view(
                session,
                namespace.registry.policies,
                diagnostics=context.frame.diagnostics,
            ),
            kind=kind,
        )
        return _merge_conversion_errors(result, conversion_errors)
    # declare/typeset scope like `local` inside a function (bash
    # semantics) and assign globally at top level, which is exactly
    # handle_local's fallback when no function scope is active. `-r`
    # rides the same path and lands on what each operand wrote, so
    # `f() { local -r A=(x); }` freezes f's own A, not the caller's.
    if keyword in (NT.LOCAL, "declare", "typeset"):
        result = await handle_local(
            operands,
            session,
            session_view(
                session,
                namespace.registry.policies,
                diagnostics=context.frame.diagnostics,
            ),
            # `declare`/`typeset` share this handler but have to name
            # themselves in a diagnostic rather than say `local`.
            cmd=cmd_word,
            kind=kind,
            shaping=shaping,
            marks=marks,
            plus="".join(sorted(plus_chars)),
            nameref="n" in flag_chars and "n" not in plus_chars,
            global_scope="g" in flag_chars,
            inherit="I" in flag_chars,
        )
        return _merge_conversion_errors(result, conversion_errors)
    # Pass export flags through so -p / bare print and bad options work.
    result = await handle_export(
        [*flag_words, *operands],
        session,
        session_view(
            session,
            namespace.registry.policies,
            diagnostics=context.frame.diagnostics,
        ),
    )
    return _merge_conversion_errors(result, conversion_errors)
