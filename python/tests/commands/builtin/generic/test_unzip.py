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
from tests.fixtures.vfs_io import install, replaces


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


@replaces("read", filetype=".zip")
async def _rendered(accessor, path, **kwargs):
    return b"RENDERED"


@pytest.mark.asyncio
async def test_a_name_with_zip_added_reads_the_stored_archive():
    # The mount renders .zip reads; unzip opens a.zip for a, as it opens
    # a.zip typed, from the bytes the store holds.
    vfs = RAMVFS()
    vfs._store.files["/a.zip"] = _zip_entries((("f.txt", b"hello\n"),))
    ws = Workspace({"/m/": (vfs, MountMode.READ)})
    install(ws.mount("/m"), [_rendered])
    result = await ws.shell("unzip -p /m/a f.txt")
    out = await result.materialize_stdout()
    await ws.close()
    assert (result.exit_code, out) == (0, b"hello\n")


async def _shell(line: str) -> tuple[int, bytes, bytes]:
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        r = await ws.shell(
            "cd /data && printf '1\\n' > a; mkdir d; "
            "printf '1\\n' > d/a; printf '2\\n' > d/b; " + line
        )
        return (
            r.exit_code,
            await r.materialize_stdout(),
            await r.materialize_stderr(),
        )
    finally:
        await ws.close()


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        pytest.param(
            "zip -q z.zip d/a; unzip -qj z.zip -d o; ls o",
            (0, b"a\n", b""),
            id="junk_paths",
        ),
        pytest.param(
            "mkdir U; echo 1 > U/F; zip -q z.zip U/F; unzip -qLL z.zip "
            "-d o; ls o o/u",
            (0, b"o:\nu\n\no/u:\nf\n", b""),
            id="lower_names",
        ),
        pytest.param(
            "zip -q z.zip d/a; unzip -qC z.zip D/A -d o; echo rc=$?; ca"
            "t o/d/a",
            (0, b"rc=0\n1\n", b""),
            id="ignore_case",
        ),
        pytest.param(
            "zip -q z.zip d/a; echo c | zip -zq z.zip; unzip -qz z.zip",
            (0, b"c\n", b""),
            id="comment",
        ),
        pytest.param(
            "zip -q z.zip d/a; mkdir -p o/d; echo NEW > o/d/a; touch -d"
            " 2030-01-01T00:00:00Z o/d/a; unzip -qu z.zip -d o; cat o/d"
            "/a",
            (0, b"NEW\n", b""),
            id="update_keeps_newer",
        ),
    ],
)
@pytest.mark.asyncio
async def test_unzip_options_behave_as_pinned(
    line: str, expected: tuple[int, bytes, bytes]
) -> None:
    assert await _shell(line) == expected
