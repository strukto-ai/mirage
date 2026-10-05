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

from mirage.commands.builtin.generic.diff import DiffFlags, diff, switch_words
from mirage.types import FileStat, FileType, PathSpec


def _operand(raw: str, virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=virtual.removeprefix("/d/"),
        raw_path=raw,
    )


DASH = _operand("-", "/d/-")
DEV_STDIN = PathSpec.from_str_path("/dev/stdin", "")
DIRS = {"/d/sub": ["x"], "/d/sub2": ["x", "y"]}


async def _readdir(path: PathSpec) -> list[str]:
    return DIRS[path.virtual]


async def _stat(path: PathSpec) -> FileStat:
    kind = FileType.DIRECTORY if path.virtual in DIRS else FileType.FILE
    return FileStat(name=path.virtual.rsplit("/", 1)[-1], type=kind)


@pytest.mark.asyncio
async def test_two_stdin_operands_are_one_file():

    async def unread(path: PathSpec) -> bytes:
        raise AssertionError(f"read {path.virtual}")

    out, io = await diff(
        [DASH, DEV_STDIN],
        read_bytes=unread,
        readdir_fn=_readdir,
        stat_fn=_stat,
        flags=DiffFlags(),
        stdin=b"abc",
    )
    assert (out, io.exit_code) == (None, 0)


def test_switch_words_keep_the_option_words_as_typed():
    assert switch_words(["-ru", "--exclude", ".git", "a", "b", "-x*.log"]) == [
        "-ru",
        "--exclude",
        ".git",
        "-x*.log",
    ]
    assert switch_words(["--exclude=.git", "-r", "a", "--", "-b"]) == [
        "--exclude=.git",
        "-r",
        "--",
    ]
    assert switch_words(["-rx", "pat", "-U", "1", "a", "b"]) == [
        "-rx",
        "pat",
        "-U",
        "1",
    ]
