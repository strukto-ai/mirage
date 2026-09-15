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


def _substitution(root):
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == "command_substitution":
            return node
        stack.extend(reversed(node.named_children))
    raise AssertionError("no substitution")


def test_nested_evaluation_gets_original_heredoc_syntax():
    source = 'echo "$(cat <<EOF\nhello\nEOF\n)"'
    node = _substitution(parse(source))
    assert b"<<EOF" in node.source_text
    assert b"<<EOF" not in node.text


def test_nested_evaluation_keeps_reader_continuation_removal():
    node = _substitution(parse("cat <<EOF\n$(printf '%s' 'a\\\nb')\nEOF"))
    assert node.source_text == b"$(printf '%s' 'ab')"


def test_later_parse_cannot_replace_an_earlier_nodes_body():
    first = parse("cat <<EOF\none\nEOF")
    parse("cat <<EOF\ntwo\nEOF")
    assert first.named_children[0].named_children[-1].heredoc.body == b"one\n"
