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

from mirage.commands.cli.builtin.git.opcodes import group_opcodes, line_opcodes


def _lines(text: str) -> list[bytes]:
    return [line.encode() for line in text.splitlines(keepends=True)]


def test_a_new_block_goes_after_the_blank_line_it_shares() -> None:
    # git 2.47.3: the insertion keeps the old blank line as context and
    # adds the new one after the block, where a longest-block matcher
    # put the blank line first.
    old = _lines("ONE = 1\n\n# Three, the\n# last of\n# them.\nTHREE = 3\n")
    new = _lines(
        "ONE = 1\n\n# Two.\nTWO = 2\n\n# Three, the\n# last of\n# them.\n"
        "THREE = 3\n"
    )
    assert line_opcodes(old, new) == [
        ("equal", 0, 2, 0, 2),
        ("insert", 2, 2, 2, 5),
        ("equal", 2, 6, 5, 9),
    ]


@pytest.mark.parametrize(
    ("old", "new", "codes"),
    [
        ("", "", []),
        ("a\n", "a\n", [("equal", 0, 1, 0, 1)]),
        ("a\nb", "a\nb\n", [("equal", 0, 1, 0, 1), ("replace", 1, 2, 1, 2)]),
        ("a\nb\n", "a\n", [("equal", 0, 1, 0, 1), ("delete", 1, 2, 1, 1)]),
    ],
)
def test_opcodes_name_each_step(
    old: str, new: str, codes: list[tuple[str, int, int, int, int]]
) -> None:
    assert line_opcodes(_lines(old), _lines(new)) == codes


def test_groups_split_on_a_long_unchanged_run() -> None:
    old = [b"%d\n" % i for i in range(20)]
    new = [line for line in old if line not in (b"3\n", b"15\n")]
    groups = group_opcodes(line_opcodes(old, new), 3)
    assert groups == [
        [("equal", 0, 3, 0, 3), ("delete", 3, 4, 3, 3), ("equal", 4, 7, 3, 6)],
        [
            ("equal", 12, 15, 11, 14),
            ("delete", 15, 16, 14, 14),
            ("equal", 16, 19, 14, 17),
        ],
    ]
    assert group_opcodes([("equal", 0, 5, 0, 5)], 3) == []
