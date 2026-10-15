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

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.stream import read_stream
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_stream_file(tmp_path):
    (tmp_path / "data.txt").write_bytes(b"stream content")
    accessor = DiskAccessor(tmp_path)
    chunks = []
    async for chunk in read_stream(
        accessor,
        PathSpec(
            vfs_path="data.txt", virtual="/data.txt", directory="/data.txt"
        ),
    ):
        chunks.append(chunk)
    assert b"".join(chunks) == b"stream content"


@pytest.mark.asyncio
async def test_stream_with_glob_scope(tmp_path):
    (tmp_path / "data.txt").write_bytes(b"abc")
    accessor = DiskAccessor(tmp_path)
    scope = PathSpec(
        vfs_path=mount_key("/disk/data.txt", "/disk"),
        virtual="/disk/data.txt",
        directory="/disk/",
    )
    chunks = []
    async for chunk in read_stream(accessor, scope):
        chunks.append(chunk)
    assert b"".join(chunks) == b"abc"


# A path under a plain file is ENOTDIR on the real filesystem, and the
# error names the virtual path, never the host one the mount resolves to.
@pytest.mark.asyncio
async def test_read_stream_under_a_plain_file_is_not_a_directory(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    spec = PathSpec(
        vfs_path="a.txt/x", virtual="/a.txt/x", directory="/a.txt/"
    )
    with pytest.raises(NotADirectoryError) as exc:
        [c async for c in read_stream(DiskAccessor(tmp_path), spec)]
    assert exc.value.filename == "/a.txt/x"
    assert str(tmp_path) not in str(exc.value)
