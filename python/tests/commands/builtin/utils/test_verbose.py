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

from mirage.commands.builtin.utils.verbose import removal_lines
from mirage.types import PathSpec


def _p(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


def test_removal_lines_chain_children_first():
    entries = [(_p("/data/lin"), True), (_p("/data/lin/sub"), True),
               (_p("/data/lin/sub/z.txt"), False)]
    assert removal_lines(entries) == [
        "removed '/data/lin/sub/z.txt'",
        "removed directory '/data/lin/sub'",
        "removed directory '/data/lin'",
    ]


def test_removal_lines_deterministic_regardless_of_input_order():
    entries = [(_p("/data/t"), True), (_p("/data/t/b.txt"), False),
               (_p("/data/t/a.txt"), False)]
    assert removal_lines(entries) == [
        "removed '/data/t/b.txt'",
        "removed '/data/t/a.txt'",
        "removed directory '/data/t'",
    ]


def test_removal_lines_single_file():
    assert removal_lines([(_p("/data/f.txt"), False)
                          ]) == ["removed '/data/f.txt'"]


def test_removal_lines_empty():
    assert removal_lines([]) == []
