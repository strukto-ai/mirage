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


from types import SimpleNamespace
from typing import cast

import pytest

from mirage.shell.parse.parse import parse
from mirage.shell.types import TSNodeLike
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
    ("echo a\necho b\n   \n\t\n", ["echo a", "echo b", "   ", "\t"]),
    ("# first\n# second\n", ["# first", "# second"]),
]


@pytest.mark.parametrize(("source", "expected"), CASES)
def test_history_entries(source: str, expected: list[str]) -> None:
    assert [e.text for e in history_entries(parse(source))] == expected


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        (
            "cat <<A <<B\na\nA\nb\nB\necho z\n",
            [("cat <<A <<B\na\nA\nb\nB\n", 0), ("echo z", 20)],
        ),
        (
            "X=$(cat <<A\na\nA\n)\ncat <<B\nb\nB\n",
            [("X=$(cat <<A\na\nA\n\n)", 0), ("cat <<B\nb\nB\n", 18)],
        ),
        ("echo ok\ncat <<A; (\n", [("echo ok", 0), ("cat <<A; (", 8)]),
        ("if true; then\necho z\n", [("if true; then\necho z", 0)]),
    ],
)
def test_history_positions(
    source: str, expected: list[tuple[str, int]]
) -> None:
    assert [(e.text, e.at) for e in history_entries(parse(source))] == expected


def test_history_nonmonotone_continuation_map() -> None:
    word = SimpleNamespace(
        type="string", start_byte=1, end_byte=4, children=[], is_named=True
    )
    command = SimpleNamespace(
        type="command",
        start_byte=0,
        end_byte=4,
        children=[word],
        is_named=True,
    )
    root = SimpleNamespace(
        text=b"abc\n",
        source_text=b"a\\\nb\\\nc\n",
        offsets=[0, 6, 1, 7, 8],
        start_byte=0,
        children=[command],
    )
    entries = history_entries(cast(TSNodeLike, root))
    assert [(e.text, e.at) for e in entries] == [("ab\\\nc", 0)]


@pytest.mark.parametrize("last", ["word", "|"])
def test_history_leaf_predecessor_tie(last: str) -> None:
    leaves = [
        SimpleNamespace(
            type=kind,
            start_byte=0,
            end_byte=1,
            children=[],
            is_named=kind == "word",
            parent=None,
        )
        for kind in (["|", "word"] if last == "word" else ["word", "|"])
    ]
    command = SimpleNamespace(
        type="command",
        start_byte=0,
        end_byte=3,
        children=[
            *leaves,
            SimpleNamespace(
                type="word",
                start_byte=2,
                end_byte=3,
                children=[],
                is_named=True,
                parent=None,
            ),
        ],
        is_named=True,
    )
    root = SimpleNamespace(text=b"a\nb\n", start_byte=0, children=[command])
    entries = history_entries(cast(TSNodeLike, root))
    assert [(e.text, e.at) for e in entries] == [
        ("a; b" if last == "word" else "a b", 0)
    ]
