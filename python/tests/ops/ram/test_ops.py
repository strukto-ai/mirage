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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.ram.mkdir import mkdir
from mirage.ops.ram.append import append_bytes
from mirage.ops.ram.create import create
from mirage.ops.ram.mkdir import mkdir as mkdir_op
from mirage.ops.ram.read.read import read
from mirage.ops.ram.readdir import readdir
from mirage.ops.ram.rename import rename
from mirage.ops.ram.rmdir import rmdir
from mirage.ops.ram.stat import stat
from mirage.ops.ram.truncate import truncate
from mirage.ops.ram.unlink import unlink
from mirage.ops.ram.write import write
from mirage.resource.ram.store import RAMStore
from mirage.types import FileType, PathSpec


def _scope(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


@pytest.fixture
def store():
    s = RAMStore()
    s.files["/hello.txt"] = b"hello"
    s.dirs.add("/sub")
    s.files["/sub/child.txt"] = b"child"
    return s


@pytest.fixture
def accessor(store):
    return RAMAccessor(store)


@pytest.fixture
def index():
    return RAMIndexCacheStore(ttl=600)


@pytest.mark.asyncio
async def test_op_read(accessor):
    result = await read(accessor, _scope("/hello.txt"), index=None)
    assert result == b"hello"


@pytest.mark.asyncio
async def test_op_read_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _scope("/nope.txt"), index=None)


@pytest.mark.asyncio
async def test_op_write(accessor, store):
    await write(accessor, _scope("/new.txt"), data=b"new data")
    assert store.files["/new.txt"] == b"new data"


@pytest.mark.asyncio
async def test_op_write_and_read(accessor):
    await write(accessor, _scope("/w.txt"), data=b"written")
    result = await read(accessor, _scope("/w.txt"), index=None)
    assert result == b"written"


@pytest.mark.asyncio
async def test_op_stat_file(accessor):
    result = await stat(accessor, _scope("/hello.txt"), index=None)
    assert result.name == "hello.txt"
    assert result.size == 5
    assert result.type == FileType.TEXT


@pytest.mark.asyncio
async def test_op_stat_directory(accessor):
    result = await stat(accessor, _scope("/sub"), index=None)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_op_readdir(accessor, index):
    result = await readdir(accessor, _scope("/"), index=index)
    assert "/hello.txt" in result
    assert "/sub" in result


@pytest.mark.asyncio
async def test_op_create(accessor, store):
    await create(accessor, _scope("/created.txt"))
    assert store.files["/created.txt"] == b""


@pytest.mark.asyncio
async def test_op_mkdir(accessor, store):
    await mkdir_op(accessor, _scope("/newdir"))
    assert "/newdir" in store.dirs


@pytest.mark.asyncio
async def test_op_unlink(accessor, store):
    await unlink(accessor, _scope("/hello.txt"))
    assert "/hello.txt" not in store.files


@pytest.mark.asyncio
async def test_op_unlink_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await unlink(accessor, _scope("/missing.txt"))


@pytest.mark.asyncio
async def test_op_rmdir(accessor, store):
    await mkdir(
        accessor,
        PathSpec(resource_path=("/empty").strip("/"),
                 virtual="/empty",
                 directory="/empty"))
    await rmdir(accessor, _scope("/empty"))
    assert "/empty" not in store.dirs


@pytest.mark.asyncio
async def test_op_rename(accessor, store):
    src = _scope("/hello.txt")
    dst = _scope("/renamed.txt")
    await rename(accessor, src, dst)
    assert "/renamed.txt" in store.files
    assert "/hello.txt" not in store.files


@pytest.mark.asyncio
async def test_op_append(accessor, store):
    await append_bytes(accessor, _scope("/hello.txt"), data=b" world")
    assert store.files["/hello.txt"] == b"hello world"


@pytest.mark.asyncio
async def test_op_truncate(accessor, store):
    await truncate(accessor, _scope("/hello.txt"), length=3)
    assert store.files["/hello.txt"] == b"hel"
