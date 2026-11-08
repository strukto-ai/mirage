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
from types import SimpleNamespace

import pytest

from mirage.commands.builtin.generic.decompress import input_info
from mirage.commands.builtin.generic.gzip import extract_level
from mirage.commands.builtin.generic.gzip import gzip as compress_inputs
from mirage.commands.errors import UsageError
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


UNDATED = "gzip: /f: warning: file timestamp out of range for gzip format\n"


async def _dated(modified: str, *, taken: bool = False, **options):
    writes = {}

    async def read(path):
        yield b"hello\n"

    async def write(path, data):
        writes[path.virtual] = await materialize(data)

    async def unlink(path):
        pass

    async def stat(path):
        if path.virtual == "/f.gz" and not taken:
            raise FileNotFoundError(path.virtual)
        return FileStat(name="f", type=FileType.FILE, modified=modified)

    body, io = await compress_inputs(
        [PathSpec.from_str_path("/f")],
        read_bytes=read,
        write_bytes=write,
        unlink=unlink,
        stat=stat,
        **options,
    )
    if body is not None:
        writes["/f.gz"] = await materialize(body)
    return writes.get("/f.gz"), io.exit_code, await io.stderr_str()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "modified,options,stamp,code,stderr",
    [
        ("1960-01-01T00:00:00Z", {}, bytes(4), 2, UNDATED),
        ("2200-01-01T00:00:00Z", {}, bytes(4), 2, UNDATED),
        ("1970-01-01T00:00:00Z", {}, bytes(4), 2, UNDATED),
        ("1970-01-01T00:00:00.5Z", {}, bytes(4), 2, UNDATED),
        ("1960-01-01T00:00:00Z", {"quiet": True}, bytes(4), 2, ""),
        ("1960-01-01T00:00:00Z", {"to_stdout": True}, bytes(4), 2, UNDATED),
        ("1960-01-01T00:00:00Z", {"named": False}, bytes(4), 0, ""),
        ("2106-02-07T06:28:15Z", {}, b"\xff\xff\xff\xff", 0, ""),
        ("1970-01-01T00:00:01Z", {}, b"\x01\0\0\0", 0, ""),
    ],
)
async def test_a_date_the_header_cannot_hold_stays_out_of_it(
    modified, options, stamp, code, stderr
):
    written, status, said = await _dated(modified, **options)
    assert (written[4:8], status, said) == (stamp, code, stderr)


@pytest.mark.asyncio
async def test_the_date_warning_lands_after_the_name_v_started():
    _, status, said = await _dated("1960-01-01T00:00:00Z", verbose=True)
    first, second, end = said.split("\n")
    assert first == f"/f:\t{UNDATED.rstrip()}"
    assert second.endswith("-- replaced with /f.gz")
    assert (end, status) == ("", 2)


@pytest.mark.asyncio
async def test_an_output_already_there_is_refused_before_the_date_warning():
    written, status, said = await _dated("1960-01-01T00:00:00Z", taken=True)
    assert written is None
    assert (status, said) == (
        2,
        "gzip: /f.gz already exists;\tnot overwritten\n",
    )


@pytest.mark.asyncio
async def test_recursion_asks_the_mount_before_touching_a_file():
    touched = []

    async def read(path):
        touched.append(path.virtual)
        yield b"x"

    async def write(path, data):
        touched.append(path.virtual)

    async def stat(path):
        kind = FileType.DIRECTORY if path.virtual == "/d" else FileType.FILE
        return FileStat(name="n", type=kind)

    async def readdir(path):
        return ["/d/a", "/d/b"]

    async def dispatch(name, path):
        assert (name, path.virtual) == ("before_full_walk", "/d")
        raise ValueError(
            "more than 1 files in scope (walk_limit); narrow the path"
        )

    with pytest.raises(UsageError) as refused:
        await compress_inputs(
            [PathSpec.from_str_path("/d")],
            read_bytes=read,
            write_bytes=write,
            unlink=write,
            stat=stat,
            readdir=readdir,
            recursive=True,
            dispatch=dispatch,
        )
    assert str(refused.value).startswith("gzip: more than 1 files")
    assert touched == []


@pytest.mark.asyncio
async def test_a_followed_link_gives_what_it_leads_to():
    async def no_follow(path):
        return FileStat(name="link", type=FileType.SYMLINK)

    async def target(virtual):
        assert virtual == "/secret"
        return FileStat(name="secret", type=FileType.FILE, mode=0o100600)

    resolver = SimpleNamespace(target=lambda link: "/secret", stat=target)
    info = await input_info(
        no_follow, PathSpec.from_str_path("/d/link"), "/d/link", resolver
    )
    assert info is not None and info.mode == 0o100600
