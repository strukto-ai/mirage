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
import io
import zipfile

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _zip_entries(entries: tuple[tuple[str, bytes], ...]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries:
            zf.writestr(name, content)
    return buf.getvalue()


def _read_only_unzip_mount() -> tuple[Workspace, RAMVFS]:
    vfs = RAMVFS()
    vfs._store.files["/a.zip"] = _zip_entries((("f.txt", b"hello\n"),))
    return Workspace({"/ro/": (vfs, MountMode.READ)}), vfs


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "unzip -t /ro/a.zip",
        "unzip -p /ro/a.zip f.txt",
    ],
)
async def test_a_read_only_mount_runs_unzip_where_it_writes_nothing(line: str):
    ws, vfs = _read_only_unzip_mount()
    before = dict(vfs._store.files)
    result = await ws.shell(line)
    await result.materialize_stdout()
    assert result.exit_code == 0
    assert vfs._store.files == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,code,stdout,stderr",
    [
        (
            "cd /ro && unzip a.zip",
            50,
            b"Archive:  a.zip\n",
            b"error:  cannot create f.txt\n        Read-only file system\n",
        ),
        (
            "unzip -d /ro/out /ro/a.zip",
            2,
            b"Archive:  /ro/a.zip\n",
            b"checkdir:  cannot create extraction directory: /ro/out\n"
            b"           Read-only file system\n",
        ),
    ],
)
async def test_a_read_only_mount_refuses_unzip_at_the_write(
    line: str, code: int, stdout: bytes, stderr: bytes
):
    # UnZip 6.00 on a read-only filesystem: a member it cannot create is
    # named as it would have made it (exit 50), an extraction directory it
    # cannot make ends the run (exit 2).
    ws, vfs = _read_only_unzip_mount()
    before = dict(vfs._store.files)
    result = await ws.shell(line)
    assert (
        result.exit_code,
        await result.materialize_stdout(),
        result.stderr,
    ) == (code, stdout, stderr)
    assert vfs._store.files == before
