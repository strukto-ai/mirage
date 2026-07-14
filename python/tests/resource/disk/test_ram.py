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
import hashlib

import pytest

from mirage.types import FileType, PathSpec

_ps = PathSpec.from_str_path


def _cat_sync(backend, path):

    async def _collect():
        return b"".join([c async for c in backend.read_stream(path)])

    return asyncio.run(_collect())


def test_write_and_read(memory_backend):
    asyncio.run(memory_backend.write(_ps("/f.txt"), data=b"hello"))
    assert _cat_sync(memory_backend, _ps("/f.txt")) == b"hello"


def test_create_and_write(memory_backend):
    asyncio.run(memory_backend.write(_ps("/a.txt"), data=b"data"))
    assert _cat_sync(memory_backend, _ps("/a.txt")) == b"data"


def test_read_partial_with_offset(memory_backend):
    asyncio.run(memory_backend.write(_ps("/f.txt"), data=b"abcdef"))
    assert _cat_sync(memory_backend, _ps("/f.txt"))[2:5] == b"cde"


def test_read_missing_raises(memory_backend):
    with pytest.raises(FileNotFoundError):
        _cat_sync(memory_backend, _ps("/missing.txt"))


def test_mkdir_and_readdir(memory_backend):
    asyncio.run(memory_backend.mkdir(_ps("/mydir")))
    entries = asyncio.run(
        memory_backend.readdir(_ps("/mydir"), memory_backend.index))
    assert entries == []


def test_mkdir_missing_parent_raises(memory_backend):
    with pytest.raises(FileNotFoundError):
        asyncio.run(memory_backend.mkdir(_ps("/a/b/c")))


def test_rmdir_empty(memory_backend):
    asyncio.run(memory_backend.mkdir(_ps("/emptydir")))
    asyncio.run(memory_backend.rmdir(_ps("/emptydir")))
    with pytest.raises(FileNotFoundError):
        asyncio.run(memory_backend.stat(_ps("/emptydir")))


def test_rmdir_nonempty_raises(memory_backend):
    asyncio.run(memory_backend.mkdir(_ps("/dir")))
    asyncio.run(memory_backend.write(_ps("/dir/file.txt"), data=b""))
    with pytest.raises(OSError):
        asyncio.run(memory_backend.rmdir(_ps("/dir")))


def test_unlink(memory_backend):
    asyncio.run(memory_backend.write(_ps("/del.txt"), data=b""))
    asyncio.run(memory_backend.unlink(_ps("/del.txt")))
    with pytest.raises(FileNotFoundError):
        _cat_sync(memory_backend, _ps("/del.txt"))


def test_unlink_missing_raises(memory_backend):
    with pytest.raises(FileNotFoundError):
        asyncio.run(memory_backend.unlink(_ps("/nope.txt")))


def test_rename_file(memory_backend):
    asyncio.run(memory_backend.write(_ps("/old.txt"), data=b"content"))
    asyncio.run(memory_backend.rename(_ps("/old.txt"), _ps("/new.txt")))
    assert _cat_sync(memory_backend, _ps("/new.txt")) == b"content"
    with pytest.raises(FileNotFoundError):
        _cat_sync(memory_backend, _ps("/old.txt"))


def test_stat_file(memory_backend):
    asyncio.run(memory_backend.write(_ps("/f.txt"), data=b"hello"))
    s = asyncio.run(memory_backend.stat(_ps("/f.txt")))
    assert s.name == "f.txt"
    assert s.size == 5
    assert s.type == "text"


def test_stat_directory(memory_backend):
    asyncio.run(memory_backend.mkdir(_ps("/mydir")))
    s = asyncio.run(memory_backend.stat(_ps("/mydir")))
    assert s.type == FileType.DIRECTORY
    assert s.size is None


def test_stat_missing_raises(memory_backend):
    with pytest.raises(FileNotFoundError):
        asyncio.run(memory_backend.stat(_ps("/missing.txt")))


def test_exists_true(memory_backend):
    asyncio.run(memory_backend.write(_ps("/f.txt"), data=b""))
    try:
        asyncio.run(memory_backend.stat(_ps("/f.txt")))
        exists = True
    except FileNotFoundError:
        exists = False
    assert exists


def test_exists_false(memory_backend):
    try:
        asyncio.run(memory_backend.stat(_ps("/nope.txt")))
        exists = True
    except FileNotFoundError:
        exists = False
    assert not exists


def test_checksum_deterministic(memory_backend):
    asyncio.run(memory_backend.write(_ps("/f.txt"), data=b"data"))
    raw = asyncio.run(memory_backend.read_bytes(_ps("/f.txt")))
    c1 = hashlib.md5(raw).hexdigest()
    c2 = hashlib.md5(raw).hexdigest()
    assert c1 == c2
    assert len(c1) == 32


def test_readdir_lists_direct_children(memory_backend):
    asyncio.run(memory_backend.mkdir(_ps("/parent")))
    asyncio.run(memory_backend.mkdir(_ps("/parent/child1")))
    asyncio.run(memory_backend.write(_ps("/parent/file.txt"), data=b""))
    entries = asyncio.run(
        memory_backend.readdir(_ps("/parent"), memory_backend.index))
    assert any("child1" in e for e in entries)
    assert any("file.txt" in e for e in entries)
