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

import pytest

from mirage.shell.node_kind import NodeKind, node_kind
from mirage.shell.parse import parse

# One snippet per statement kind. The map must cover the full enum
# (asserted below), so adding a NodeKind without deciding how it
# classifies fails here before it can drift between the walkers.
SNIPPETS = {
    NodeKind.COMMENT: "# a comment",
    NodeKind.PROGRAM: "true",
    NodeKind.COMMAND: "cat /data/a.txt",
    NodeKind.PIPELINE: "cat /data/a.txt | wc -l",
    NodeKind.LIST: "true && false",
    NodeKind.REDIRECT: "cat /data/a.txt > /data/b.txt",
    NodeKind.SUBSHELL: "(true)",
    NodeKind.COMPOUND: "{ true; }",
    NodeKind.IF: "if true; then false; fi",
    NodeKind.FOR: "for i in 1 2; do true; done",
    NodeKind.SELECT: "select x in a b; do true; done",
    NodeKind.WHILE: "while true; do false; done",
    NodeKind.UNTIL: "until false; do true; done",
    NodeKind.CASE: "case x in x) true;; esac",
    NodeKind.FUNCTION_DEF: "f() { true; }",
    NodeKind.DECLARATION: "export FOO=1",
    NodeKind.UNSET: "unset FOO",
    NodeKind.TEST: "[[ -n x ]]",
    NodeKind.NEGATED: "! true",
    NodeKind.VAR_ASSIGN: "FOO=1",
    NodeKind.UNSUPPORTED: "for ((i=0;i<2;i++)); do true; done",
}


def _first_statement(snippet: str):
    root = parse(snippet)
    assert root.type == "program"
    return root.named_children[0]


def test_snippets_cover_the_full_enum():
    assert set(SNIPPETS) == set(NodeKind)


@pytest.mark.parametrize("kind", list(NodeKind))
def test_node_kind_classifies(kind):
    node = _first_statement(SNIPPETS[kind])
    if kind == NodeKind.PROGRAM:
        node = parse(SNIPPETS[kind])
    assert node_kind(node) == kind


def test_select_and_until_disambiguate():
    assert node_kind(_first_statement("select x in a; do true; done")) \
        == NodeKind.SELECT
    assert node_kind(_first_statement("for i in a; do true; done")) \
        == NodeKind.FOR
    assert node_kind(_first_statement("until false; do true; done")) \
        == NodeKind.UNTIL
    assert node_kind(_first_statement("while true; do false; done")) \
        == NodeKind.WHILE
