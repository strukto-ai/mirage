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

from mirage.shell.parse.parse import parse
from mirage.workspace.history.entries import history_entries

# Each pinned against Debian Bash 5.2.37, `bash --norc -i` with `set +H`.
CASES = [
    ("echo a\necho b; echo c\n", ["echo a", "echo b; echo c"]),
    ("for i in 1 2\ndo echo $i\ndone\n", ["for i in 1 2; do echo $i; done"]),
    (
        "if true\nthen\necho y\nelse\necho n\nfi\n",
        ["if true; then echo y; else echo n; fi"],
    ),
    ("f()\n{\n:\n}\n", ["f() { :; }"]),
    ("echo a |\ncat\ntrue &&\necho b\n", ["echo a | cat", "true && echo b"]),
    ("echo c \\\n  d\n", ["echo c   d"]),
    ('echo "q\nr" $(echo a\necho b)\n', ['echo "q\nr" $(echo a\necho b)']),
    ("case y in\ny)\necho y\n;;\nesac\n", ["case y in y) echo y; ;; esac"]),
    (
        "if (true)\nthen :\nfi\na=(1\n2)\n",
        ["if (true); then :; fi", "a=(1 2)"],
    ),
    (
        "cat <<A; echo after\nbody\nA\necho z\n",
        ["cat <<A; echo after\nbody\nA\n", "echo z"],
    ),
    (
        "if true; then cat <<A\nx\nA\nfi\n",
        ["if true; then cat <<A\nx\nA\n fi"],
    ),
    ("X=$(cat <<A\nx\nA\n)\n", ["X=$(cat <<A\nx\nA\n\n)"]),
    ("X=$(curl a \\\n  -H b)\n", ["X=$(curl a \\\n  -H b)"]),
    ("for i in 1\n# c\ndo :\ndone\n", ["for i in 1\ndo :; done"]),
    ("if true # why\nthen :; fi\n", ["if true # why\nthen :; fi"]),
    ("if true\n\nthen :\n   \nfi\n", ["if true;  then :;     fi"]),
    ("# note\n\n   \nfalse\n", ["# note", "   ", "false"]),
]


@pytest.mark.parametrize(("source", "expected"), CASES)
def test_history_entries(source: str, expected: list[str]) -> None:
    assert [e.text for e in history_entries(parse(source))] == expected
