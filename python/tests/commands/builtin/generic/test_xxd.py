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


async def _stream(path):
    yield DATA


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "seek,limit,out",
    [
        (
            "2",
            None,
            "00000002: 6667 68                                  fgh\n",
        ),
        ("-2", 1, "00000003: 67                                       g\n"),
        ("10", None, ""),
        ("1", 0, ""),
        (
            "0",
            None,
            "00000000: 6465 6667 68                             defgh\n",
        ),
    ],
)
async def test_a_dump_starts_its_addresses_at_the_seek(seek, limit, out):
    stdout, io = await xxd(
        [F], read_stream=_stream, seek=parse_seek(seek), limit=limit
    )
    assert (await materialize(stdout)).decode() == out
    assert io.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("seek", ["-10", "+-2"])
async def test_a_seek_before_the_start_cannot_seek(seek):
    stdout, io = await xxd([F], read_stream=_stream, seek=parse_seek(seek))
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
