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
import io
import tarfile

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

CHILD_FAILED = (b"tar: Child returned status 1\n"
                b"tar: Error is not recoverable: exiting now\n")


def _tar(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


OK = gzip.compress(_tar({"d/a.txt": b"hello\n", "d/b.txt": b"bee\n"}), mtime=0)
# The same archive with its CRC-32 and length trailer zeroed.
DAMAGED = OK[:-8] + b"\0" * 8


async def _shell(line: str, seed: dict[str, bytes]):
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    for path, data in seed.items():
        await ws.shell(f"tee {path} > /dev/null", stdin=data)
    r = await ws.shell(line)
    return (r.exit_code, await r.materialize_stdout(), await
            r.materialize_stderr())


@pytest.mark.asyncio
async def test_a_non_gzip_archive_is_gzips_refusal_then_tars():
    # GNU tar 1.35 reads -z through a gzip -d child and dies when it
    # fails, after gzip's own line.
    r = await _shell("tar -tzf /data/c.tgz", {"/data/c.tgz": b"corrupted\n"})
    assert r == (2, b"", b"gzip: stdin: not in gzip format\n" + CHILD_FAILED)


@pytest.mark.asyncio
async def test_a_damaged_trailer_still_yields_every_member():
    seed = {"/data/bad.tgz": DAMAGED}
    reasons = (b"gzip: stdin: invalid compressed data--crc error\n"
               b"gzip: stdin: invalid compressed data--length error\n")
    assert await _shell("tar -tzf /data/bad.tgz nomatch",
                        seed) == (2, b"", reasons + CHILD_FAILED)
    r = await _shell("tar -xzf /data/bad.tgz -C /data; cat /data/d/*", seed)
    assert r == (0, b"hello\nbee\n", reasons + CHILD_FAILED)


@pytest.mark.asyncio
async def test_the_gzip_magic_takes_the_same_road_without_z():
    r = await _shell("tar -tf /data/junk.tgz", {"/data/junk.tgz": OK + b"xy"})
    assert r == (2, b"d/a.txt\nd/b.txt\n",
                 b"gzip: stdin: decompression OK, trailing garbage ignored\n"
                 b"tar: Child returned status 2\n"
                 b"tar: Error is not recoverable: exiting now\n")


@pytest.mark.asyncio
async def test_a_member_cut_short_yields_nothing():
    r = await _shell("tar -tzf /data/cut.tgz", {"/data/cut.tgz": OK[:-40]})
    assert r == (2, b"",
                 b"gzip: stdin: unexpected end of file\n" + CHILD_FAILED)


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [OK[:-8], OK[:-3], OK + OK[:2]])
@pytest.mark.parametrize("flags", ["-tzf", "-tf", "-xOzf"])
async def test_a_truncated_gzip_wrapper_keeps_complete_tar_members(
        data, flags):
    out = b"hello\nbee\n" if flags == "-xOzf" else b"d/a.txt\nd/b.txt\n"
    r = await _shell(f"tar {flags} /data/cut.tgz", {"/data/cut.tgz": data})
    assert r == (2, out,
                 b"gzip: stdin: unexpected end of file\n" + CHILD_FAILED)


@pytest.mark.asyncio
async def test_a_truncated_gzip_trailer_still_extracts_to_disk():
    r = await _shell("tar -xzf /data/cut.tgz -C /data; cat /data/d/*",
                     {"/data/cut.tgz": OK[:-3]})
    assert r == (0, b"hello\nbee\n",
                 b"gzip: stdin: unexpected end of file\n" + CHILD_FAILED)


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", ["-tzf", "-xzf", "-xOzf"])
async def test_a_tar_parse_error_does_not_mask_the_gzip_failure(flags):
    bad = gzip.compress(b"not a tar\n", mtime=0)[:-8] + b"\0" * 8
    r = await _shell(f"tar {flags} /data/bad.tgz", {"/data/bad.tgz": bad})
    assert r == (2, b"", b"gzip: stdin: invalid compressed data--crc error\n"
                 b"gzip: stdin: invalid compressed data--length error\n" +
                 CHILD_FAILED)
