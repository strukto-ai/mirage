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

from mirage.shell.helpers import get_text
from mirage.shell.parse import parse
from mirage.shell.types import NodeType as NT
from mirage.workspace.node.test_tokens import (
    CondParser,
    ExprToken,
    cond_leaves,
    cond_tokens,
    flat_tokens,
)


def _test_node(line: str):
    stack = [parse(line)]
    while stack:
        node = stack.pop()
        if node.type == NT.TEST_COMMAND:
            return node
        stack.extend(reversed(node.children))
    raise AssertionError(f"no test in {line!r}")


def _spelled(token: ExprToken) -> str:
    if token.op is not None:
        return token.op
    return ("-" if token.negative else "") + get_text(token.operand)


def test_flat_tokens_are_the_words_test_is_given():
    # A `-N` tree-sitter splits is one operand again, as test reads it.
    node = _test_node("[ -e x -o ! 1 -lt -2 ]")
    assert [_spelled(t) for t in flat_tokens(node)] == [
        "-e",
        "x",
        "-o",
        "!",
        "1",
        "-lt",
        "-2",
    ]


def test_cond_leaves_are_each_test_in_source_order():
    node = _test_node("[[ ! -e a && ( b == c* || -n d ) ]]")
    leaves = cond_leaves(CondParser(cond_tokens(node)).parse())
    assert [(leaf[0], leaf[1]) for leaf in leaves] == [
        ("unary", "-e"),
        ("binary", "=="),
        ("unary", "-n"),
    ]
