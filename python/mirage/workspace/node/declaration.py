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
from mirage.shell.call_stack import CallStack
from mirage.shell.helpers import get_declaration_keyword, get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.variable import VarAttr
from mirage.shell.voice import shell_voice
from mirage.shell.xtrace import trace_array, trace_command
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins import handle_declare_functions
from mirage.workspace.executor.builtins.declare.constants import (
    VISIBLE_SCOPE_BUILTINS,
)
from mirage.workspace.executor.builtins.declare.declare import (
    declared,
    mark_names,
)
from mirage.workspace.executor.builtins.declare.types import (
    DeclarationOperand,
)
from mirage.workspace.executor.builtins.help import flag_help
from mirage.workspace.executor.builtins.shared import builtin_usage, fail
from mirage.workspace.expand import expand_node
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.node.assignment import expand_array_items
from mirage.workspace.node.types import ExpandedWords
from mirage.workspace.session.state import deciding, prefix_temporaries
from mirage.workspace.types import ExecutionNode

# Every letter GNU's `declare` accepts, so a typo refuses with the usage
# line instead of being silently dropped.
_DECLARE_LETTERS = frozenset("aAfFgiIlnprtux")


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


async def execute_declaration(
    node: Any,
    context: EvaluationContext,
    execute_fn: Callable[..., Any],
    registry: MountRegistry,
    namespace: Namespace,
    cs: CallStack | None,
    expanded_words: ExpandedWords | None = None,
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
        expanded_words (ExpandedWords | None): filled with the words the
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
            expanded = await expand_node(child, context, execute_fn, cs)
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
            expanded = await expand_node(child, context, execute_fn, cs)
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
    if expanded_words is not None:
        expanded_words.words = (cmd_word, *traced)
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
            [*flag_words, *operands], context, execute_fn, cs, attr
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
    temporaries = prefix_temporaries(session)
    return await declared(
        cmd_word,
        lambda shell: shell.declare(
            cmd_word,
            "".join(sorted(flag_chars)),
            "".join(sorted(plus_chars)),
            operands,
            temporaries,
            True,
            deciding(),
        ),
        context,
        execute_fn,
        cs,
    )
