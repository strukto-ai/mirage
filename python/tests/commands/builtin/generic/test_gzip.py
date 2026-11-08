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

import gzip
import zlib

import pytest

from mirage.commands.builtin.generic.gzip import extract_level
from mirage.commands.builtin.generic.gzip import gzip as compress_inputs
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec
from mirage.workspace.executor.command.flags import parse_flags


def _level(argv: list[str]) -> int:
    parsed = parse_flags(argv, SPECS["gzip"], "gzip", "/")
    return extract_level(FlagView(parsed.flag_kwargs, spec=SPECS["gzip"]))


@pytest.mark.parametrize(
    "argv,level",
    [
        *(([f"-{digit}"], digit) for digit in range(1, 10)),
        ([], zlib.Z_DEFAULT_COMPRESSION),
        (["-1", "-9"], 9),
    ],
)
def test_the_digit_flags_select_the_level(argv: list[str], level: int):
    """-1..-9 each select their own level, -1 included; none keeps zlib's.

    ``-1`` is the one digit the parser disambiguates (``args_1``), so a
    bag read by the bare digit missed it and silently compressed at
    zlib's default. Of several, the highest digit wins.
    """
    assert _level(argv) == level


@pytest.mark.asyncio
@pytest.mark.parametrize("skipped", [False, True])
async def test_compression_skips_suffixed_streams_and_reports_late_errors(
    skipped,
):
    reads = []
    writes = {}
    removed = []
    name = "/bad.gz" if skipped else "/bad"

    async def read(path):
        reads.append(path.virtual)
        yield b"hello\n"
        if path.virtual == name:
            reads.append("continued")
            raise PermissionError(path.virtual)

    async def write(path, data):
        writes[path.virtual] = await materialize(data)

    async def unlink(path):
        removed.append(path.virtual)

    _, io = await compress_inputs(
        [PathSpec.from_str_path(name), PathSpec.from_str_path("/good")],
        read_bytes=read,
        write_bytes=write,
        unlink=unlink,
    )
    assert io.exit_code == (0 if skipped else 1)
    assert io.stderr == (
        b"gzip: /bad.gz already has .gz suffix -- unchanged\n"
        if skipped
        else b"\ngzip: /bad: Permission denied\n"
    )
    assert reads == ([name, "/good"] if skipped else [name, "continued"])
    assert removed == (["/good"] if skipped else [])
    assert set(writes) == ({"/good.gz"} if skipped else set())
    if skipped:
        assert gzip.decompress(writes["/good.gz"]) == b"hello\n"


@pytest.mark.asyncio
async def test_compression_stores_the_input_time_and_keeps_its_attributes():
    """The header stores the input's time unless -n, and the output
    takes the input's mode and times."""
    writes = {}
    attrs = []

    async def read(path):
        yield b"hello\n"

    async def write(path, data):
        writes[path.virtual] = await materialize(data)

    async def unlink(path):
        pass

    async def stat(path):
        if path.virtual == "/f.gz":
            raise FileNotFoundError(path.virtual)
        return FileStat(
            name="f",
            type=FileType.FILE,
            mode=0o100640,
            modified="2001-02-03T04:05:06Z",
        )

    async def set_attrs(path, fields):
        attrs.append((path.virtual, fields))

    for named in (None, False):
        _, io = await compress_inputs(
            [PathSpec.from_str_path("/f")],
            read_bytes=read,
            write_bytes=write,
            unlink=unlink,
            stat=stat,
            set_attrs=set_attrs,
            named=named,
        )
        assert io.exit_code == 0
        header = writes["/f.gz"][:10]
        assert header[4:8] == (
            (981173106).to_bytes(4, "little") if named is None else bytes(4)
        )
    assert attrs[0] == (
        "/f.gz",
        {"mode": 0o640, "mtime": "2001-02-03T04:05:06Z"},
    )
