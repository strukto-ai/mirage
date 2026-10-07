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

from mirage.shell.helpers import get_function_body
from mirage.shell.parse import parse
from mirage.shell.printer import function_text, stored_function_text


def test_function_text_reads_the_definition_under_its_redirects():
    # get_function_body wraps a body under two redirects in a statement
    # of its own; the printer finds the definition again from it.
    definition = parse("f() { echo a; } >o 2>&1").named_children[0]
    body = get_function_body(definition.named_children[0])
    assert function_text("f", body) == "f () \n{ \n    echo a\n} > o 2>&1"


def test_stored_function_text_prints_the_definitions_own_heredocs():
    # bash prints a definition's heredoc bodies after its closing line.
    source = "f() { cat; } <<A >/dev/null <<B\na\nA\nb\nB"
    assert stored_function_text("f", source) == (
        "f () \n{ \n    cat\n} <<A > /dev/null <<B\na\nA\nb\nB\n"
    )
