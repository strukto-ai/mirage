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

from mirage.commands.builtin.generic.diff import (
    DiffFlags,
    c_escape,
    diff,
    switch_words,
)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.timezone import resolve_tz


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


def test_c_escape_quotes_a_header_name_the_way_diffutils_does():
    assert c_escape("plain/é\x7f") == "plain/é\x7f"
    assert c_escape("sp ace") == '"sp ace"'
    assert c_escape('t\tq"b\\') == '"t\\tq\\"b\\\\"'
    assert c_escape("c\x01") == '"c\\001"'


@pytest.mark.asyncio
async def test_unified_headers_carry_each_side_mtime():
    files = {"/d/a b": b"x\ny\n", "/d/c": b"x\nz\n"}

    async def read(path: PathSpec) -> bytes:
        return files[path.virtual]

    async def stat(path: PathSpec) -> FileStat:
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        return FileStat(
            name=path.virtual,
            type=FileType.FILE,
            modified="2026-01-02T03:04:05Z",
        )

    pair = [_operand("a b", "/d/a b"), _operand("c", "/d/c")]
    out, io = await diff(
        pair,
        read_bytes=read,
        readdir_fn=_readdir,
        stat_fn=stat,
        flags=DiffFlags(unified=True),
    )
    assert io.exit_code == 1
    assert isinstance(out, bytes)
    assert out.splitlines()[:2] == [
        b'--- "a b"\t2026-01-02 03:04:05.000000000 +0000',
        b"+++ c\t2026-01-02 03:04:05.000000000 +0000",
    ]
    out, _ = await diff(
        [pair[1], _operand("gone", "/d/gone")],
        read_bytes=read,
        readdir_fn=_readdir,
        stat_fn=stat,
        flags=DiffFlags(unified=True, new_file=True, new_first=True),
    )
    assert isinstance(out, bytes)
    assert out.splitlines()[1] == (
        b"+++ gone\t1970-01-01 00:00:00.000000000 +0000"
    )


@pytest.mark.asyncio
async def test_unified_headers_read_the_time_the_namespace_keeps():
    async def read(path: PathSpec) -> bytes:
        return b"x\n" if path.virtual == "/d/a" else b"y\n"

    async def stat(path: PathSpec) -> FileStat:
        return FileStat(
            name=path.virtual,
            type=FileType.FILE,
            modified="2026-10-05T00:00:00Z",
        )

    async def stat_path(virtual: str) -> FileStat | None:
        return FileStat(
            name=virtual, type=FileType.FILE, modified="2021-06-15T12:00:00Z"
        )

    out, _ = await diff(
        [_operand("a", "/d/a"), _operand("b", "/d/b")],
        read_bytes=read,
        readdir_fn=_readdir,
        stat_fn=stat,
        flags=DiffFlags(unified=True),
        stat_path=stat_path,
    )
    assert isinstance(out, bytes)
    assert out.splitlines()[0] == b"--- a\t2021-06-15 12:00:00.000000000 +0000"


@pytest.mark.asyncio
async def test_unified_headers_read_in_the_tz_zone_with_every_digit():
    async def read(path: PathSpec) -> bytes:
        return b"x\n"

    async def stat_path(virtual: str) -> FileStat | None:
        return FileStat(
            name=virtual,
            type=FileType.FILE,
            modified="2026-03-04T05:06:07.123456789Z",
        )

    async def missing(path: PathSpec) -> FileStat:
        if path.virtual == "/d/gone":
            raise FileNotFoundError(path.virtual)
        return FileStat(name=path.virtual, type=FileType.FILE)

    out, _ = await diff(
        [_operand("a", "/d/a"), _operand("gone", "/d/gone")],
        read_bytes=read,
        readdir_fn=_readdir,
        stat_fn=missing,
        flags=DiffFlags(unified=True, new_file=True, new_first=True),
        stat_path=stat_path,
        zone=resolve_tz("Asia/Hong_Kong"),
    )
    assert isinstance(out, bytes)
    assert out.splitlines()[:2] == [
        b"--- a\t2026-03-04 13:06:07.123456789 +0800",
        b"+++ gone\t1970-01-01 08:00:00.000000000 +0800",
    ]
