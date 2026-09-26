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


def _archive() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("keep.txt", b"keep\n")
        zf.writestr("drop.txt", b"drop\n")
    return buf.getvalue()


async def _run(line: str) -> tuple[int, bytes, dict[str, bytes]]:
    source, dest = RAMVFS(), RAMVFS()
    source.load_state({"files": {"/a.zip": _archive()}})
    ws = Workspace({"/a": source, "/b": dest}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(line)
        out = await result.materialize_stdout()
        return result.exit_code, out, dest.get_state()["files"]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("flag,head", [
    ("-v", b"Archive:  /a/a.zip\n Length   Method"),
    ("-l", b"  Length      Name\n"),
])
async def test_relay_listing_letters_list_instead_of_extracting(flag, head):
    exit_code, out, written = await _run(f"unzip {flag} /a/a.zip -d /b/out")
    assert exit_code == 0
    assert out.startswith(head)
    assert written == {}


@pytest.mark.asyncio
async def test_relay_extraction_honours_excludes():
    exit_code, _, written = await _run(
        "unzip -q /a/a.zip -x drop.txt -d /b/out")
    assert exit_code == 0
    assert written == {"/out/keep.txt": b"keep\n"}
