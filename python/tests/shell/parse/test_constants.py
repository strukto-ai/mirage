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

from mirage.shell.parse import parse
from mirage.shell.parse.constants import (ARITH_TEST_OPERATORS,
                                          DECLARING_NODES, TARGET_NAME_FIELDS)
from mirage.workspace.executor.builtins.condition.constants import \
    INT_COMPARATORS


def test_arith_test_operators_match_the_executor():
    """The parse-side set may not drift from the comparators `[[` runs
    as arithmetic (condition/tree.py); parse cannot import upward, so
    the spellings live twice and this pins them together."""
    assert ARITH_TEST_OPERATORS == frozenset(INT_COMPARATORS)


def test_target_name_fields_match_the_grammar():
    for node_type, field in TARGET_NAME_FIELDS.items():
        source = {
            "variable_assignment": "X=1",
            "for_statement": "for X in a; do :; done",
        }[node_type]
        node = parse(source).named_children[0]
        assert node.type == node_type
        target = node.child_by_field_name(field)
        assert target is not None and target.text == b"X"


def test_declaring_nodes_match_the_grammar():
    shapes = {"export X": "declaration_command", "unset X": "unset_command"}
    assert {parse(src).named_children[0].type
            for src in shapes} == DECLARING_NODES
