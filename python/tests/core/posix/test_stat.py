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

from mirage.core.posix.stat import parse_tree, tree_command
from mirage.core.posix.types import TreeRow


def test_tree_command_quotes_the_scope_and_the_format():
    assert tree_command("data/a b") == (
        "env LC_ALL=C find -L 'data/a b' "
        "-printf '%y %m %s %T@ %A@ %u %g %P\\0'"
    )


def test_tree_command_bounds_the_depth():
    assert tree_command("/tmp", 1) == (
        "env LC_ALL=C find -L '/tmp' -maxdepth 1 "
        "-printf '%y %m %s %T@ %A@ %u %g %P\\0'"
    )


def test_parse_tree_reads_each_record():
    out = b"d 755 4096 1700000000.5 1700000001.0 root root \0f 644 3 1 2 a b x y\0"
    assert parse_tree(out) == [
        TreeRow("d", 0o755, 4096, 1700000000, 1700000001, "root", "root", ""),
        TreeRow("f", 0o644, 3, 1, 2, "a", "b", "x y"),
    ]


def test_parse_tree_refuses_a_cut_record():
    assert parse_tree(b"f 644 3 1 2 a b x") is None
    assert parse_tree(b"f 64z 3 1 2 a b x\0") is None
