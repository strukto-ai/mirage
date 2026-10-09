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

from mirage.shell.xtrace import trace_assignment, trace_command


def test_trace_command_plain_words():
    assert trace_command(["echo", "hi"]) == b"+ echo hi\n"


def test_trace_command_quotes_spaces():
    assert trace_command(["echo", "a b"]) == b"+ echo 'a b'\n"


def test_trace_command_empty_word():
    assert trace_command(["echo", ""]) == b"+ echo ''\n"


def test_trace_command_safe_specials_unquoted():
    assert trace_command(["grep", "-c", "a=b"]) == b"+ grep -c a=b\n"


def test_trace_assignment_plain():
    assert trace_assignment("x", "5", False) == "+ x=5"


def test_trace_assignment_append():
    assert trace_assignment("x", "y", True) == "+ x+=y"


def test_trace_assignment_empty_value():
    assert trace_assignment("x", "", False) == "+ x="


def test_trace_assignment_quotes_value():
    assert trace_assignment("x", "a b", False) == "+ x='a b'"
