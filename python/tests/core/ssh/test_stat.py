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

import asyncssh
import pytest

from mirage.core.ssh.stat import attrs_to_file_stat, tree, tree_command
from mirage.types import FileType, PathSpec
from mirage.utils.dates import epoch_to_iso
from tests.fixtures.ssh_run import RunAccessor

TOP = b"d 755 4096 1700000000.5 1700000001.0 1000 1000 \0"


def _scope(vfs_path: str = "") -> PathSpec:
    virtual = "/s/" + vfs_path if vfs_path else "/s"
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=vfs_path, raw_path=virtual
    )


def test_tree_command_quotes_the_scope_and_the_format():
    assert tree_command("data/a b") == (
        "env LC_ALL=C find -L 'data/a b' "
        "-printf '%y %m %s %T@ %A@ %U %G %P\\0'"
    )


@pytest.mark.asyncio
async def test_tree_renders_each_entry_as_stat_does():
    out = TOP + (
        b"f 644 5 1700000000.9 1700000002.0 1000 1000 a.txt\0"
        b"d 700 4096 1700000003.0 1700000003.0 1000 1000 sub\0"
        b"f 4600 0 1700000004.2 1700000004.0 1000 1000 sub/b b.md\0"
    )
    accessor = RunAccessor("data", (0, out, b""))
    rows = await tree(accessor, _scope("in"))
    assert accessor.sent == [tree_command("data/in")]
    assert rows is not None
    assert sorted(rows) == ["a.txt", "sub", "sub/b b.md"]
    assert rows["a.txt"] == attrs_to_file_stat(
        "a.txt",
        asyncssh.SFTPAttrs(
            type=asyncssh.FILEXFER_TYPE_REGULAR,
            size=5,
            permissions=0o644,
            atime=1700000002,
            mtime=1700000000,
        ),
    )
    assert rows["a.txt"].modified == epoch_to_iso(1700000000)
    assert rows["sub"].type is FileType.DIRECTORY
    assert rows["sub"].size is None
    assert rows["sub/b b.md"].name == "b b.md"
    assert rows["sub/b b.md"].mode == 0o4600


@pytest.mark.asyncio
async def test_an_empty_directory_has_no_rows():
    assert await tree(RunAccessor("/", (0, TOP, b"")), _scope()) == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        (1, TOP, b""),
        (0, TOP, b"find: 'x': Permission denied\n"),
        (0, TOP + b"l 777 7 1.0 1.0 0 0 gone\0", b""),
        (0, TOP + b"p 644 0 1.0 1.0 0 0 fifo\0", b""),
        (0, b"f 644 5 1.0 1.0 0 0 \0", b""),
        (0, TOP + b"f 644 5 1.0\0", b""),
        (0, TOP[:-1], b""),
        (1, b"This service allows sftp connections only.\n", b""),
        OSError("closed"),
        asyncssh.ChannelOpenError(2, "refused"),
    ],
)
async def test_anything_but_a_clean_find_leaves_the_walk(answer):
    assert await tree(RunAccessor("/", answer), _scope()) is None
