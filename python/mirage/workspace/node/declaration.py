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

from functools import partial
from typing import Any, Callable, TypeVar

from mirage.io import IOResult
from mirage.policy import PolicyDenied
from mirage.policy.policies import pre_session_gate
from mirage.policy.types import SessionContext
from mirage.shell.array import ShellArray, make_array
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import DiscardSignal
from mirage.shell.helpers import get_declaration_keyword, get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import ShellValue, VarAttr, VarKind
from mirage.shell.voice import shell_voice
from mirage.shell.xtrace import trace_array, trace_command
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins import (
    handle_declare_functions,
    handle_declare_print,
    handle_local,
    note_local_array,
)
from mirage.workspace.executor.builtins.declare.constants import (
    LISTED_ATTRIBUTES,
    VISIBLE_SCOPE_BUILTINS,
)
from mirage.workspace.executor.builtins.declare.declare import (
    declared_kind,
    element_name,
    held_value,
    kind_conflict,
    mark_names,
    start_local,
)
from mirage.workspace.executor.builtins.declare.types import (
    AttrMarks,
    Declaration,
    DeclarationOperand,
)
from mirage.workspace.executor.builtins.help import flag_help
from mirage.workspace.executor.builtins.shared import builtin_usage, fail
from mirage.workspace.expand import expand_node
from mirage.workspace.expand.node import expand_subscript
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.assignment import expand_array_items
from mirage.workspace.node.types import ExpandedWords
from mirage.workspace.session.state import (
    conversion_scalar,
    ensure_var_visible,
    seed_var,
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
    )
    new_node = ExecutionNode(command=node.command, exit_code=1, stderr=merged)
    return stream, new_io, new_node


# Every letter GNU's `declare` accepts, so a typo refuses with the usage
# line instead of being silently dropped. `-a`/`-A` are kinds, not
# attributes, and are handled by the array branch; `-p`/`-f`/`-F`/`-g`
# /`-I` are modes the handlers read. `-n` stores the reference and every
# reader and writer resolves through it (`deref` in `session/state`).
_DECLARE_LETTERS = frozenset("aAfFgiIlnprtux")
# `-l` displaces `-u` and vice versa; the record keeps one.
_DISPLACES = {"l": VarAttr.UPPER, "u": VarAttr.LOWER}
# The attributes that shape a value as it stores.
_SHAPING = frozenset({VarAttr.INTEGER, VarAttr.LOWER, VarAttr.UPPER})
# A word or an operand of either kind, handed back as the kind it came in.
_Operand = TypeVar("_Operand", str, DeclarationOperand)


def _declare_option_refusal(
    cmd: str, flag_chars: set[str], plus_chars: set[str]
) -> tuple[Any, IOResult, ExecutionNode] | None:
    """The refusal a `declare` family option cluster earns, if any.

    An unknown letter is GNU's `invalid option` plus the usage line,
    exit 2, and it wins over every other check because bash refuses
    the cluster before it looks at a single operand.

    Args:
        cmd (str): the builtin's own name for the diagnostic.
        flag_chars (set[str]): the `-` letters, `--` excluded.
        plus_chars (set[str]): the `+` letters.
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
    return fail(
        cmd,
        f"{shell_voice()}{cmd}: {sign}{bad}: invalid option\n{builtin_usage(cmd)}",
        2,
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
            marks.append((VarAttr(c), True))
            if c in _DISPLACES:
                marks.append((_DISPLACES[c], False))
        elif c in plus_chars and c != "r":
            marks.append((VarAttr(c), False))
    return tuple(marks)


async def execute_declaration(
    node: Any,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
    view: SessionView,
    declared: ExpandedWords | None = None,
) -> tuple[Any, IOResult, ExecutionNode]:
    """Execute one declaration statement (export/local/declare/readonly).

    The executor only reads the operands: it expands them and sorts out
    the option letters, keeping the words and the staged array literals
    in the order typed, then hands them to the builtin handler that owns
    the keyword, which marks each operand with the attribute letters
    (`-x`, `-i`, `-l`) at its place, so `declare -rx X=1` keeps both
    marks.

    Args:
        node (Any): the ``declaration_command`` node.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (Callable): recursive execute for substitutions.
        registry (MountRegistry): mount registry for glob resolution.
        namespace (Namespace): addressing authority holding the links.
        cs (CallStack | None): function-call scope, if any.
        view (SessionView): the gated session view, bound once
            for the line so a pre_session rule governs an
            expansion-time write exactly as it governs `X=d`.
        declared (ExpandedWords | None): filled with the words the
            statement expanded to, its keyword first.
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
    traced: list[str] = []
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
                traced.append(key.removesuffix("+"))
                continue
            expanded = await expand_node(
                child, context, execute_fn, cs, registry.policies
            )
            operands.append(expanded)
            traced.append(expanded)
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
                child, context, execute_fn, cs, registry.policies
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
            traced.append(expanded)
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
                and keyword not in VISIBLE_SCOPE_BUILTINS
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
    if declared is not None:
        declared.words = (cmd_word, *traced)
    if session.shell_options.get("xtrace"):
        # Traced once expanded, before the builtin runs and outside its
        # redirects: each array operand, then the command naming them.
        staged = [op for op in operands if not isinstance(op, str)]
        context.frame.diagnostics.append(
            b"".join(trace_array(n, items, add) for n, add, items in staged)
            + trace_command([cmd_word, *traced])
        )
    if traced and traced[0] == "--help":
        # bash answers `--help` as the first word with the builtin's
        # help, before it reads a single option.
        answered = flag_help(cmd_word)
        if answered is not None:
            return answered
    if keyword in VISIBLE_SCOPE_BUILTINS:
        # Array literals travel as data: the handler stores them through
        # the session view and owns both refusal voices, so the executor
        # only expands and stages. The flags pass through so -p, the bare
        # listing and bad options work.
        attr = VarAttr.READONLY if keyword == "readonly" else VarAttr.EXPORT
        return await mark_names(
            [*flag_words, *operands], session, view, attr, registry.policies
        )
    refused = _declare_option_refusal(cmd_word, flag_chars, plus_chars)
    if refused is not None:
        return refused
    if "f" in flag_chars or "F" in flag_chars:
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
        return await handle_declare_print(words, session, flag_chars, keyword)
    conversion_errors: list[str] = []
    kind = declared_kind(flag_chars)
    # A bare element operand (`declare t[1]`, `local h[2]`) declares its
    # name an array, as `declare -a t` does.
    elements = {
        word.partition("[")[0] for word in words if _element_base(word) != word
    }
    if elements:
        operands = [_element_base(operand) for operand in operands]
        words = [_element_base(word) for word in words]
    if kind is not None or elements:
        # `declare -a NAME` / `declare -A NAME` with no value declare
        # an empty array of that kind, so ${#NAME[@]} is 0 and an
        # element write leaves the other slots unassigned. GNU
        # refuses to convert between the two kinds and says so per
        # name while the rest of the operands still declare.
        for bare in words:
            want = kind or (VarKind.INDEXED if bare in elements else None)
            if "=" in bare or want is None:
                continue
            want_assoc = want is VarKind.ASSOC
            # A hidden name refuses like any assignment spelling
            # before anything lands, and the array both branches below
            # write (the top-level one migrates an existing scalar)
            # goes through the gate as any write does.
            try:
                ensure_var_visible(session, bare)
            except PolicyDenied as exc:
                raise DiscardSignal(encode_text(f"{exc.strerror}\n")) from exc
            fresh = (
                "g" not in flag_chars
                and session.vars.shell.in_function()
                and not session.vars.shell.is_local(bare)
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
            conflict = kind_conflict(held, want)
            if conflict is not None:
                conversion_errors.append(
                    f"{shell_voice()}{cmd_word}: {bare}: {conflict}"
                )
                continue
            if isinstance(held, dict if want_assoc else ShellArray):
                continue
            # A local of another kind starts empty; at top level an
            # existing scalar becomes element 0, or the value at the
            # literal key "0" (GNU allows scalar-to-associative
            # conversion, unlike indexed).
            scalar = None if local else conversion_scalar(session, bare)
            fill: ShellValue = (
                ({} if scalar is None else {"0": scalar})
                if want_assoc
                else make_array([] if scalar is None else [scalar])
            )
            if view.is_readonly(bare, False):
                # bash converts a readonly name all the same, which a
                # gated write refuses, so the rule is asked on its own
                # before the ungated one lands it.
                try:
                    await pre_session_gate(
                        registry.policies,
                        SessionContext(
                            verb="set",
                            key=bare,
                            value=scalar or "",
                            session_id=session.session_id,
                        ),
                    )
                except PolicyDenied as exc:
                    raise DiscardSignal(
                        encode_text(f"{exc.strerror}\n")
                    ) from exc
                seed_var(session, bare, fill)
            else:
                try:
                    await view.set(bare, fill, follow_ref=False)
                except PolicyDenied as exc:
                    raise DiscardSignal(
                        encode_text(f"{exc.strerror}\n")
                    ) from exc
            if held is None:
                # Declared over nothing (a `local -I` holds the caller's
                # value): `declare -p` prints no value and a bare `set`
                # leaves it out until a write.
                session.vars.shell.unassigned(bare)
    # declare/typeset scope like `local` inside a function (bash
    # semantics) and assign globally at top level, which is exactly
    # handle_local's fallback when no function scope is active. `-r`
    # rides the same path and lands on what each operand wrote, so
    # `f() { local -r A=(x); }` freezes f's own A, not the caller's.
    decl = Declaration(
        cmd=cmd_word,
        kind=kind,
        shaping=shaping,
        marks=marks,
        plus="".join(sorted(plus_chars)),
        nameref="n" in flag_chars and "n" not in plus_chars,
        global_scope="g" in flag_chars,
        inherit="I" in flag_chars,
    )
    result = await handle_local(
        operands,
        session,
        view,
        decl,
        registry.policies,
        partial(
            expand_subscript,
            context=context,
            execute_fn=execute_fn,
            call_stack=cs,
            policies=registry.policies,
        ),
    )
    return _merge_conversion_errors(result, conversion_errors)


def _element_base(operand: _Operand) -> _Operand:
    """A bare element operand as the name it declares, any other as is.

    Args:
        operand (_Operand): one operand, a word or a staged array.
    """
    if isinstance(operand, str):
        name = element_name(operand)
        if name is not None:
            return name
    return operand
