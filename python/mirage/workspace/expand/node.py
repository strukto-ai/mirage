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

import shlex
from collections.abc import Callable

import tree_sitter

from mirage.shell.arith import evaluate_arith
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError
from mirage.shell.types import NodeType as NT
from mirage.utils.path import expand_tilde
from mirage.workspace.expand.constants import ARITH_DELIMITERS, ARITH_OPERATORS
from mirage.workspace.expand.variable import _expand_braces, _lookup_var
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir


def _unescape_unquoted(text: str) -> str:
    if "\\" not in text:
        return text
    try:
        parts = shlex.split(text, posix=True)
    except ValueError:
        return text
    return parts[0] if parts else text


async def expand_arith(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable,
    call_stack: CallStack | None,
) -> str:
    """Reconstruct arithmetic expression text for the shared evaluator.

    ``$``-expansions substitute textually (bash performs expansions
    before arithmetic evaluation), while bare variable names stay as
    names so the evaluator can resolve and assign them
    (``$(( y = 3 ))`` needs ``y``, not its value).
    """
    parts = []
    for child in ts_node.children:
        if child.type in ARITH_DELIMITERS:
            continue
        if child.type in (NT.BINARY_EXPRESSION, NT.UNARY_EXPRESSION,
                          NT.PARENTHESIZED_EXPRESSION, NT.TERNARY_EXPRESSION,
                          NT.POSTFIX_EXPRESSION):
            parts.append(await expand_arith(child, session, execute_fn,
                                            call_stack))
        elif child.type in ARITH_OPERATORS:
            parts.append(child.text.decode())
        elif child.type == NT.NUMBER:
            parts.append(child.text.decode())
        elif child.type in (NT.SIMPLE_EXPANSION, NT.EXPANSION,
                            NT.COMMAND_SUBSTITUTION):
            parts.append(await expand_node(child, session, execute_fn,
                                           call_stack))
        elif child.type == NT.VARIABLE_NAME:
            parts.append(child.text.decode())
        else:
            parts.append(await expand_node(child, session, execute_fn,
                                           call_stack))
    return " ".join(parts)


async def expand_node(
    ts_node: tree_sitter.Node,
    session: Session,
    execute_fn: Callable,
    call_stack: CallStack | None = None,
) -> str:
    """Expand a tree-sitter node to a string."""
    ntype = ts_node.type

    if ntype == NT.WORD:
        word = _unescape_unquoted(ts_node.text.decode())
        return expand_tilde(word, home_dir(session))

    if ntype == NT.NUMBER:
        return ts_node.text.decode()

    if ntype == NT.COMMAND_NAME:
        # The name is a word like any other: $CMD, "quoted", $(sub) all
        # expand. A bare word has one named child (or none) and falls
        # through to its own expansion rule.
        for child in ts_node.named_children:
            return await expand_node(child, session, execute_fn, call_stack)
        return ts_node.text.decode()

    if ntype == NT.SIMPLE_EXPANSION:
        raw = ts_node.text.decode()
        dollar = raw.rfind("$")
        prefix = raw[:dollar]
        var = raw[dollar + 1:]
        return prefix + _lookup_var(var, session, call_stack)

    if ntype == NT.EXPANSION:
        return _expand_braces(ts_node, session.env,
                              getattr(session, "arrays", {}), call_stack)

    if ntype == NT.COMMAND_SUBSTITUTION:
        inner_cmds = [
            c for c in ts_node.named_children
            if c.type in (NT.COMMAND, NT.PIPELINE, NT.LIST,
                          NT.REDIRECTED_STATEMENT, NT.SUBSHELL)
        ]
        if not inner_cmds:
            return ""
        inner = inner_cmds[0].text.decode()
        io = await execute_fn(inner, session_id=session.session_id)
        return (await io.stdout_str()).rstrip("\n")

    if ntype == NT.ARITHMETIC_EXPANSION:
        expr = await expand_arith(ts_node, session, execute_fn, call_stack)
        try:
            value, updates = evaluate_arith(expr, session.env)
        except ArithError:
            return ts_node.text.decode()
        session.env.update(updates)
        return str(value)

    if ntype == NT.CONCATENATION:
        parts = []
        for child in ts_node.children:
            parts.append(await expand_node(child, session, execute_fn,
                                           call_stack))
        return "".join(parts)

    if ntype == NT.STRING:
        parts = []
        prev_end_row = None
        for child in ts_node.children:
            if child.type == NT.DQUOTE:
                continue
            if (prev_end_row is not None
                    and child.start_point[0] > prev_end_row):
                parts.append("\n")
            parts.append(await expand_node(child, session, execute_fn,
                                           call_stack))
            prev_end_row = child.end_point[0]
        return "".join(parts)

    if ntype == NT.STRING_CONTENT:
        # Bash double-quote escapes: \$, \`, \", \\, \<newline>.
        # Everything else preserves the backslash literally.
        text = ts_node.text.decode()
        text = text.replace("\\\\", "\x00")
        text = text.replace('\\"', '"')
        text = text.replace("\\$", "$")
        text = text.replace("\\`", "`")
        text = text.replace("\\\n", "")
        text = text.replace("\x00", "\\")
        return text

    if ntype == NT.RAW_STRING:
        raw = ts_node.text.decode()
        return raw[1:-1]

    if ntype == NT.VARIABLE_ASSIGNMENT:
        raw = ts_node.text.decode()
        if "=" in raw:
            key, _, val_part = raw.partition("=")
            val_nodes = [
                c for c in ts_node.named_children if c.type != NT.VARIABLE_NAME
            ]
            if val_nodes:
                expanded = await expand_node(val_nodes[0], session, execute_fn,
                                             call_stack)
                return f"{key}={expanded}"
            return f"{key}={val_part}"
        return raw

    return ts_node.text.decode()
