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

from mirage.workspace.executor.builtins.condition.operands import (
    file_operands,
)


@pytest.mark.parametrize(
    ("name", "words", "kinds"),
    [
        ("test", ["-e", "x"], [None, "path"]),
        ("test", ["-e", "-o", "yes"], [None, None, None]),
        ("test", ["-e", "-a", "x"], [None, None, None]),
        ("test", ["-f", "-o", "-e", "x"], [None, None, None, "path"]),
        ("test", ["!", "-e", "x"], [None, None, "path"]),
        ("test", ["-e", "=", "x"], [None, None, None]),
        ("test", ["a", "-nt", "b"], ["path", None, "path"]),
        ("[", ["-e", "x", "]"], [None, "path", None]),
        ("[[", ["-e", "-o"], [None, "path"]),
    ],
)
def test_file_operands_are_the_words_test_reads_as_files(name, words, kinds):
    # The gate reads a test's files off the evaluator's own reading, so
    # `-o` after `-e` joins two strings for both, and names no file.
    assert file_operands(name, words) == kinds
