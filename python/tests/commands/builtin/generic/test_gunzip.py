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

import pytest

from mirage.commands.builtin.generic.gunzip import gunzip_writes
from mirage.commands.spec import SPECS
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command.flags import parse_flags


@pytest.mark.parametrize("argv,writes", [
    ([], False),
    (["-c", "f.txt.gz"], False),
    (["-t", "f.txt.gz"], False),
    (["f.txt.gz"], True),
    (["-k", "f.txt.gz"], True),
])
def test_gunzip_writes_only_the_files_it_replaces(argv: list[str],
                                                  writes: bool):
    parsed = parse_flags(argv, SPECS["gunzip"], "gunzip", "/data")
    assert gunzip_writes(parsed.flag_kwargs, parsed.paths) is writes


@pytest.mark.asyncio
async def test_a_dash_goes_to_stdout_while_files_decompress_in_place():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/b.txt > /dev/null", stdin=b"file\n")
    r = await ws.shell(
        "cd /data && gzip b.txt && gunzip - b.txt.gz; ls; cat b.txt",
        stdin=gzip.compress(b"hi\n"))
    assert await r.materialize_stdout() == b"hi\nb.txt\nfile\n"


def test_gunzip_writes_nothing_for_a_dash_operand():
    # A `-` has no file to replace: gunzip decompresses stdin to stdout.
    dash = PathSpec(virtual="/data/-",
                    directory="/data/",
                    vfs_path="-",
                    resolved=True,
                    raw_path="-")
    flags = parse_flags([], SPECS["gunzip"], "gunzip", "/data").flag_kwargs
    assert gunzip_writes(flags, [dash]) is False


@pytest.mark.asyncio
async def test_a_plain_file_is_reported_and_left_in_place():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/b.txt > /dev/null", stdin=b"file\n")
    await ws.shell("tee /data/p.gz > /dev/null", stdin=b"plain\n")
    r = await ws.shell("cd /data && gzip b.txt && gunzip p.gz b.txt.gz; ls")
    assert await r.materialize_stdout() == b"b.txt\np.gz\n"
    assert await r.materialize_stderr(
    ) == b"gunzip: p.gz: not in gzip format\n"


@pytest.mark.asyncio
async def test_plain_stdin_is_not_in_gzip_format():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    r = await ws.shell("gunzip", stdin=b"hello\n")
    assert r.exit_code == 1
    assert await r.materialize_stderr(
    ) == b"gunzip: stdin: not in gzip format\n"


# gzip -n of "hello\n" with its CRC-32 and length trailer zeroed.
DAMAGED = gzip.compress(b"hello\n", mtime=0)[:-8] + b"\0" * 8


@pytest.mark.asyncio
async def test_a_damaged_trailer_keeps_the_inflated_bytes():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/bad.gz > /dev/null", stdin=DAMAGED)
    await ws.shell("tee /data/ok.gz > /dev/null", stdin=gzip.compress(b"x\n"))
    r = await ws.shell("gunzip -c /data/bad.gz /data/ok.gz")
    assert r.exit_code == 1
    assert await r.materialize_stdout() == b"hello\n"
    assert await r.materialize_stderr() == (
        b"gunzip: /data/bad.gz: invalid compressed data--crc error\n"
        b"gunzip: /data/bad.gz: invalid compressed data--length error\n")
    r = await ws.shell("gunzip -t /data/bad.gz /data/ok.gz; ls /data")
    assert await r.materialize_stdout() == b"bad.gz\nok.gz\n"


@pytest.mark.asyncio
async def test_a_later_members_bad_header_keeps_the_members_before_it():
    good = gzip.compress(b"hello\n", mtime=0)
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/two.gz > /dev/null",
                   stdin=good + good[:2] + b"\x07" + good[3:])
    r = await ws.shell("cd /data && gunzip two.gz; ls; cat two")
    assert await r.materialize_stdout() == b"two\nhello\n"
    assert await r.materialize_stderr() == (
        b"gunzip: two.gz: unknown method 7 -- not supported\n")
