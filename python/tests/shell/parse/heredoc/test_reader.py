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

from mirage.shell.parse.heredoc.reader import discover_heredocs, read_body


def test_reader_discovers_two_inputs_without_grammar_hints():
    source = b"cat <<A <<B\none\nA\ntwo\nB"
    first, second = discover_heredocs(source, [])
    assert first.body == b"one\n"
    assert second.body == b"two\n"
    assert first.terminated and second.terminated
    assert source[second.body_start:second.end] == b"two\nB"


def test_reader_ignores_operator_text_in_shell_words():
    source = b"echo '<<X' ${x:-<<Y} $((1 << 2)) # <<Z\n"
    assert discover_heredocs(source, []) == []


def test_continuation_precedes_delimiter_comparison():
    body = read_body(b"keep\nEO\\\nF\nafter", 0, b"EOF", False, False)
    assert body.body == b"keep\n"
    assert body.terminated
    assert body.end == 11


def test_quoted_body_keeps_continuations_and_tabs():
    body = read_body(b"\tEO\\\nF\nEOF", 0, b"EOF", True, False)
    assert body.body == b"\tEO\\\nF\n"
    assert body.terminated


def test_unclosed_delimiter_quote_is_left_as_a_syntax_error():
    assert discover_heredocs(b"cat <<'EOF\nbody", []) == []


@pytest.mark.parametrize("expression", [
    "$[1 << 2]",
    "$[1 << $[1 + 1]]",
    "$[a[0] << 2]",
    "$[a[1 << 2] << 3]",
    "$[1 << $(echo 2)]",
    "$[1 <<\n2]",
])
def test_legacy_arithmetic_hides_shifts_but_not_the_following_heredoc(
        expression):
    source = f"echo {expression}; cat <<EOF\nbody\nEOF".encode()
    document, = discover_heredocs(source, [])
    assert document.delimiter == "EOF"
    assert document.body == b"body\n"
    assert document.terminated


def test_unclosed_legacy_arithmetic_does_not_create_a_heredoc():
    assert discover_heredocs(b"echo $[1 << 2", []) == []
