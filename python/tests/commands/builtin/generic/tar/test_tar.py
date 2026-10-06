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


def _tar(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


OK = gzip.compress(_tar({"d/a.txt": b"hello\n", "d/b.txt": b"bee\n"}), mtime=0)


async def _shell(line: str, seed: dict[str, bytes]):
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    for path, data in seed.items():
        await ws.shell(f"tee {path} > /dev/null", stdin=data)
    r = await ws.shell(line)
    return (
        r.exit_code,
        await r.materialize_stdout(),
        await r.materialize_stderr(),
    )


@pytest.mark.asyncio
async def test_lists_the_member_a_cut_short_stream_reaches():
    # The stream holds the first header and no data block: GNU lists the
    # member it reached, then stops there without its child's status
    # (tar 1.35, same bytes).
    r = await _shell("tar -tzf /data/cut.tgz", {"/data/cut.tgz": OK[:-40]})
    assert r == (
        2,
        b"d/a.txt\n",
        b"\ngzip: stdin: unexpected end of file\n"
        b"tar: Unexpected EOF in archive\n"
        b"tar: Error is not recoverable: exiting now\n",
    )


@pytest.mark.asyncio
async def test_stdout_archive_needs_no_writable_root_and_does_not_create_dash():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.READ)
    await ws.shell("printf hello > /data/a")
    result = await ws.shell("tar -cvf - -C /data a | tar -xOf -")
    assert result.exit_code == 0
    assert await result.materialize_stdout() == b"hello"
    assert await result.materialize_stderr() == b"a\n"
    assert (await ws.shell("test ! -e /-")).exit_code == 0
    await ws.close()
