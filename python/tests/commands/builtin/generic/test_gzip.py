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

import asyncio
import gzip
import zlib

import pytest

from mirage.commands.builtin.generic.gzip import extract_level
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command.flags import parse_flags


def _level(argv: list[str]) -> int:
    parsed = parse_flags(argv, SPECS["gzip"], "gzip", "/")
    return extract_level(FlagView(parsed.flag_kwargs, spec=SPECS["gzip"]))


@pytest.mark.parametrize("digit", list(range(1, 10)))
def test_every_digit_flag_selects_its_level(digit: int):
    """-1..-9 each select their own level, including -1.

    ``-1`` is the one digit the parser disambiguates (``args_1``), so a
    bag read by the bare digit missed it and silently compressed at
    zlib's default.
    """
    assert _level([f"-{digit}"]) == digit


def test_no_digit_flag_keeps_the_zlib_default():
    assert _level([]) == zlib.Z_DEFAULT_COMPRESSION


def test_the_highest_digit_wins():
    """GNU takes the last level flag; the parser leaves all of them set."""
    assert _level(["-1", "-9"]) == 9


def _read_only_gzip_mount() -> tuple[Workspace, RAMVFS]:
    vfs = RAMVFS()
    vfs._store.files["/f.txt"] = b"hello\n"
    vfs._store.files["/f.txt.gz"] = gzip.compress(b"hello\n")
    return Workspace({"/ro/": (vfs, MountMode.READ)}), vfs


@pytest.mark.parametrize("line,stdout", [
    ("cd /ro && printf 'x\\n' | gzip | gunzip", b"x\n"),
    ("gzip -c /ro/f.txt | gunzip", b"hello\n"),
    ("gzip -dc /ro/f.txt.gz", b"hello\n"),
    ("cd /ro && printf 'x\\n' | gzip - | gunzip -", b"x\n"),
])
def test_a_read_only_mount_runs_gzip_where_it_writes_nothing(
        line: str, stdout: bytes):
    ws, vfs = _read_only_gzip_mount()
    before = dict(vfs._store.files)
    result = asyncio.run(ws.shell(line))
    assert (result.exit_code, result.stdout) == (0, stdout)
    assert vfs._store.files == before


@pytest.mark.parametrize("line,refused", [
    ("gzip /ro/f.txt", "/ro/f.txt.gz"),
    ("gzip -k /ro/f.txt", "/ro/f.txt.gz"),
    ("gzip -d /ro/f.txt.gz", "/ro/f.txt"),
])
def test_a_read_only_mount_refuses_gzip_at_the_write(line: str, refused: str):
    # Nothing refuses the command before it runs: the write of the
    # replacement file is what the mount refuses, in gzip's own voice,
    # and the operand it would have replaced is left in place.
    ws, vfs = _read_only_gzip_mount()
    before = dict(vfs._store.files)
    result = asyncio.run(ws.shell(line))
    assert result.exit_code == 1
    assert result.stderr == f"gzip: {refused}: Read-only file system\n".encode(
    )
    assert vfs._store.files == before


@pytest.mark.asyncio
async def test_a_dash_goes_to_stdout_while_files_compress_in_place():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/a.txt > /dev/null", stdin=b"file\n")
    r = await ws.shell("cd /data && gzip - a.txt | gzip -dc; ls",
                       stdin=b"hi\n")
    assert await r.materialize_stdout() == b"hi\na.txt.gz\n"
