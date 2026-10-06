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

import pytest

from mirage.core.document.read import read
from mirage.core.document.readdir import readdir
from mirage.core.document.stat import stat
from mirage.types import FileType, PathSpec
from mirage.vfs.document.document import DocumentVFS

ROOT = PathSpec(vfs_path="", virtual="/VFS.md", directory="/")


def _vfs(text: list[str]) -> DocumentVFS:
    return DocumentVFS("VFS.md", lambda: text[0], "vfs")


@pytest.mark.asyncio
async def test_every_read_renders_again():
    text = ["first\n"]
    vfs = _vfs(text)
    assert await read(vfs.accessor, ROOT) == b"first\n"
    text[0] = "second\n"
    assert await read(vfs.accessor, ROOT) == b"second\n"


@pytest.mark.asyncio
async def test_stat_is_the_rendered_byte_length():
    vfs = _vfs(["café\n"])
    st = await stat(vfs.accessor, ROOT)
    assert (st.name, st.type, st.size) == ("VFS.md", FileType.FILE, 6)
    assert vfs.sizes_always_known is True


@pytest.mark.asyncio
async def test_nothing_lives_below_the_file():
    vfs = _vfs(["x"])
    below = PathSpec(vfs_path="a", virtual="/VFS.md/a", directory="/VFS.md")
    with pytest.raises(FileNotFoundError):
        await read(vfs.accessor, below)
    with pytest.raises(NotADirectoryError):
        await readdir(vfs.accessor, ROOT)
