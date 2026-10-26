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

from mirage.rs.shell import parse_shell
from mirage.shell.parse.heredoc import HeredocOperator, heredoc_operators
from mirage.shell.types import TSNodeLike


def _root(command: str) -> TSNodeLike:
    return parse_shell(command).root_node


def test_heredoc_operators_reads_the_delimiter_as_bash_does():
    assert heredoc_operators(_root("cat <<-'EOF'\n\tbody\n\tEOF\n")) == [
        HeredocOperator(
            word_start=7, word_end=12, delimiter="EOF", allows_indent=True
        )
    ]


def test_heredoc_operators_are_in_source_order():
    operators = heredoc_operators(_root("cat <<A\none\nA\ncat <<B\ntwo\nB\n"))
    assert [op.delimiter for op in operators] == ["A", "B"]


def test_heredoc_operators_finds_two_on_one_line():
    operators = heredoc_operators(_root("cat <<A ; cat <<B\none\nA\ntwo\nB\n"))
    assert [op.delimiter for op in operators] == ["A", "B"]
