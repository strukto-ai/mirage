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

from enum import StrEnum
from typing import Any

from mirage.shell.types import NodeType as NT


class NodeKind(StrEnum):
    """Statement kinds both tree walkers dispatch on.

    The executor and the provision planner walk the same tree-sitter
    AST. This enum is the single classification both use, so a
    construct cannot be supported by one walker and silently
    unclassified by the other: `node_kind` owns every tree-sitter
    node-type check, including the lookahead that distinguishes
    `select` from `for` and `until` from `while`.
    """
    COMMENT = "comment"
    PROGRAM = "program"
    COMMAND = "command"
    PIPELINE = "pipeline"
    LIST = "list"
    REDIRECT = "redirect"
    SUBSHELL = "subshell"
    COMPOUND = "compound"
    IF = "if"
    FOR = "for"
    SELECT = "select"
    WHILE = "while"
    UNTIL = "until"
    CASE = "case"
    FUNCTION_DEF = "function_def"
    DECLARATION = "declaration"
    UNSET = "unset"
    TEST = "test"
    NEGATED = "negated"
    VAR_ASSIGN = "var_assign"
    UNSUPPORTED = "unsupported"


_SIMPLE_KINDS = {
    NT.COMMENT: NodeKind.COMMENT,
    NT.PROGRAM: NodeKind.PROGRAM,
    NT.COMMAND: NodeKind.COMMAND,
    NT.PIPELINE: NodeKind.PIPELINE,
    NT.LIST: NodeKind.LIST,
    NT.REDIRECTED_STATEMENT: NodeKind.REDIRECT,
    NT.SUBSHELL: NodeKind.SUBSHELL,
    NT.COMPOUND_STATEMENT: NodeKind.COMPOUND,
    NT.IF_STATEMENT: NodeKind.IF,
    NT.CASE_STATEMENT: NodeKind.CASE,
    NT.FUNCTION_DEFINITION: NodeKind.FUNCTION_DEF,
    NT.DECLARATION_COMMAND: NodeKind.DECLARATION,
    NT.UNSET_COMMAND: NodeKind.UNSET,
    NT.TEST_COMMAND: NodeKind.TEST,
    NT.NEGATED_COMMAND: NodeKind.NEGATED,
    NT.VARIABLE_ASSIGNMENT: NodeKind.VAR_ASSIGN,
}


def node_kind(node: Any) -> NodeKind:
    """Classify a tree-sitter node into the shared statement kind.

    Args:
        node (Any): tree-sitter node.

    Returns:
        NodeKind: statement kind, or UNSUPPORTED for node types
        neither walker implements (c-style for, arithmetic, ...).
    """
    ntype = node.type
    simple = _SIMPLE_KINDS.get(ntype)
    if simple is not None:
        return simple
    if ntype == NT.FOR_STATEMENT:
        if node.children and node.children[0].type == NT.SELECT:
            return NodeKind.SELECT
        return NodeKind.FOR
    if ntype == NT.WHILE_STATEMENT:
        if node.children and node.children[0].type == NT.UNTIL:
            return NodeKind.UNTIL
        return NodeKind.WHILE
    return NodeKind.UNSUPPORTED
