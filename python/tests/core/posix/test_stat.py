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

from mirage.core.posix.stat import parse_tree, tree_command
from mirage.core.posix.types import TreeRow


def test_tree_command_quotes_the_scope_and_the_format():
    assert tree_command("data/a b") == (
        "env LC_ALL=C find -L 'data/a b' "
        "-printf '%y %m %s %T@ %A@ %U %G %P\\0'"
    )


def test_tree_command_bounds_the_depth():
    assert tree_command("/tmp", 1) == (
        "env LC_ALL=C find -L '/tmp' -maxdepth 1 "
        "-printf '%y %m %s %T@ %A@ %U %G %P\\0'"
    )


def test_parse_tree_reads_each_record():
    out = (
        b"d 755 4096 1700000000.5 1700000001.0 0 0 \0f 644 3 1 2 1000 50 x y\0"
    )
    assert parse_tree(out) == [
        TreeRow(
            "d",
            0o755,
            4096,
            1700000000,
            1700000001,
            1700000000500,
            1700000001000,
            0,
            0,
            "",
        ),
        TreeRow("f", 0o644, 3, 1, 2, 1000, 2000, 1000, 50, "x y"),
    ]


@pytest.mark.parametrize(
    ("stamp", "want"),
    [
        ("1700000000.1234567890", 1700000000123),
        ("1.0004999999", 1000),
        ("1.0005000000", 1001),
        ("1.", 1000),
        ("-1.5000000000", -1500),
    ],
)
def test_parse_tree_keeps_the_time_to_the_millisecond(stamp, want):
    rows = parse_tree(f"f 644 0 {stamp} {stamp} a b x\0".encode())
    assert rows is not None
    assert (rows[0].mtime_ms, rows[0].atime_ms) == (want, want)


# The whole seconds stay those SFTP reports, never rounded across a second
# as the milliseconds are.
def test_parse_tree_keeps_sftp_s_whole_seconds():
    rows = parse_tree(b"f 644 0 1700000000.9996 1700000000.9996 a b x\0")
    assert rows is not None
    assert (rows[0].mtime, rows[0].mtime_ms) == (1700000000, 1700000001000)


def test_parse_tree_refuses_a_cut_record():
    assert parse_tree(b"f 644 3 1 2 a b x") is None
    assert parse_tree(b"f 64z 3 1 2 0 0 x\0") is None
    assert parse_tree(b"f 644 3 1 2 root root x\0") is None
