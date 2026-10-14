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

from mirage.commands.builtin.generic.xxd import (
    XxdSeek,
    parse_limit,
    parse_seek,
    strtol,
    xxd,
)
from mirage.io.stream import materialize
from mirage.types import PathSpec

DATA = b"defgh"
F = PathSpec(virtual="/f", directory="/", vfs_path="f", raw_path="/f")


@pytest.mark.parametrize(
    "raw,value",
    [
        ("2", 2),
        ("0x2", 2),
        ("017", 15),
        ("2k", 2),
        ("x", 0),
        ("08", 0),
        ("-3", -3),
    ],
)
def test_strtol_reads_base_zero_and_drops_the_rest(raw, value):
    assert strtol(raw) == value


@pytest.mark.parametrize(
    "raw,seek",
    [
        ("2", XxdSeek(2)),
        ("+2", XxdSeek(2, relative=True)),
        ("-2", XxdSeek(2, back=True)),
        ("+-2", XxdSeek(2, relative=True, back=True)),
    ],
)
def test_parse_seek_reads_the_signs(raw, seek):
    assert parse_seek(raw) == seek


def _io(read: list[str]):
    async def stream(path):
        read.append("stream")
        yield DATA

    async def read_range(path, *, offset, size):
        read.append(f"{offset}+{size}")
        return DATA[offset : offset + size]

    async def size_of(path):
        return len(DATA)

    return stream, read_range, size_of


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "seek,limit,out,reads",
    [
        (
            "2",
            None,
            "00000002: 6667 68                                  fgh\n",
            ["2+3"],
        ),
        (
            "-2",
            1,
            "00000003: 67                                       g\n",
            ["3+1"],
        ),
        ("10", None, "", []),
        ("1", 0, "", []),
        (
            "0",
            None,
            "00000000: 6465 6667 68                             defgh\n",
            ["stream"],
        ),
    ],
)
async def test_a_dump_seeks_with_one_ranged_read(seek, limit, out, reads):
    read: list[str] = []
    stream, read_range, size_of = _io(read)
    stdout, io = await xxd(
        [F],
        read_stream=stream,
        seek=parse_seek(seek),
        limit=limit,
        read_range=read_range,
        size_of=size_of,
    )
    assert (await materialize(stdout)).decode() == out
    assert io.exit_code == 0
    assert read == reads


@pytest.mark.asyncio
@pytest.mark.parametrize("seek", ["-10", "+-2"])
async def test_a_seek_before_the_start_cannot_seek(seek):
    stream, read_range, size_of = _io([])
    stdout, io = await xxd(
        [F],
        read_stream=stream,
        seek=parse_seek(seek),
        read_range=read_range,
        size_of=size_of,
    )
    assert (stdout, io.exit_code, io.stderr) == (
        None,
        4,
        b"xxd: Sorry, cannot seek.\n",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "seek,code,out",
    [
        ("2", 0, "00000002: 6667 68                                  fgh\n"),
        ("-2", 4, ""),
        ("10", 4, ""),
    ],
)
async def test_stdin_is_read_off_and_cannot_seek_back(seek, code, out):
    async def stream(path):
        yield b""

    stdout, io = await xxd(
        [], read_stream=stream, stdin=DATA, seek=parse_seek(seek)
    )
    got = b"" if stdout is None else await materialize(stdout)
    assert (got.decode(), io.exit_code) == (out, code)


@pytest.mark.parametrize(
    "raw,limit", [(None, None), ("2", 2), ("0", 0), ("x", 0), ("-1", None)]
)
def test_parse_limit_reads_no_limit_for_a_negative_count(raw, limit):
    assert parse_limit(raw) == limit


@pytest.mark.asyncio
async def test_a_seek_without_a_limit_reads_growing_blocks():
    data = bytes(range(256)) * 1024
    asked: list[tuple[int, int]] = []

    async def stream(path):
        raise AssertionError("streamed")
        yield b""

    async def read_range(path, *, offset, size):
        asked.append((offset, size))
        return data[offset : offset + size]

    async def size_of(path):
        return len(data)

    stdout, _ = await xxd(
        [F],
        read_stream=stream,
        seek=parse_seek("16"),
        read_range=read_range,
        size_of=size_of,
    )
    first = await anext(stdout)
    assert first.startswith(b"00000010: 1011 1213")
    assert asked == [(16, 64 * 1024)]
