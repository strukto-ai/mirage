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

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _read_only_gunzip_mount() -> tuple[Workspace, RAMVFS]:
    vfs = RAMVFS()
    vfs._store.files["/f.txt.gz"] = gzip.compress(b"hello\n")
    return Workspace({"/ro/": (vfs, MountMode.READ)}), vfs


@pytest.mark.asyncio
@pytest.mark.parametrize("line,stdout", [
    ("gunzip -c /ro/f.txt.gz", b"hello\n"),
    ("gunzip -t /ro/f.txt.gz && echo ok", b"ok\n"),
    ("cd /ro && gunzip < f.txt.gz", b"hello\n"),
    ("cd /ro && gunzip - < f.txt.gz", b"hello\n"),
])
async def test_a_read_only_mount_runs_gunzip_where_it_writes_nothing(
        line: str, stdout: bytes):
    ws, vfs = _read_only_gunzip_mount()
    before = dict(vfs._store.files)
    result = await ws.shell(line)
    assert (result.exit_code, await result.materialize_stdout()) == (0, stdout)
    assert vfs._store.files == before


@pytest.mark.asyncio
@pytest.mark.parametrize("line",
                         ["gunzip /ro/f.txt.gz", "gunzip -k /ro/f.txt.gz"])
async def test_a_read_only_mount_refuses_gunzip_at_the_write(line: str):
    ws, vfs = _read_only_gunzip_mount()
    before = dict(vfs._store.files)
    result = await ws.shell(line)
    assert result.exit_code == 1
    assert result.stderr == b"gunzip: /ro/f.txt: Read-only file system\n"
    assert vfs._store.files == before


@pytest.mark.asyncio
async def test_a_dash_goes_to_stdout_while_files_decompress_in_place():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.shell("tee /data/b.txt > /dev/null", stdin=b"file\n")
    r = await ws.shell(
        "cd /data && gzip b.txt && gunzip - b.txt.gz; ls; cat b.txt",
        stdin=gzip.compress(b"hi\n"))
    assert await r.materialize_stdout() == b"hi\nb.txt\nfile\n"


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
