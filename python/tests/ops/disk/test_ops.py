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
from mirage.cache.index import RAMIndexCacheStore
from mirage.ops.disk import OPS
from mirage.types import PathSpec


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


read = _op("read")
readdir = _op("readdir")
stat = _op("stat")
write = _op("write")


@pytest.mark.asyncio
async def test_stat_op(tmp_path):
    (tmp_path / "f.txt").write_text("data")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path="f.txt", virtual="/f.txt", directory="/")
    result = await stat(accessor, scope, index=index)
    assert result.name == "f.txt"
    assert result.size == 4


@pytest.mark.asyncio
async def test_readdir_op(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path="",
                     virtual="/",
                     directory="/",
                     resolved=False)
    result = await readdir(accessor, scope, index=index)
    assert result == ["/a.txt"]


@pytest.mark.asyncio
async def test_read_op(tmp_path):
    (tmp_path / "f.txt").write_bytes(b"content")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path="f.txt", virtual="/f.txt", directory="/")
    result = await read(accessor, scope, index=index)
    assert result == b"content"


@pytest.mark.asyncio
async def test_write_op(tmp_path):
    accessor = DiskAccessor(tmp_path)
    scope = PathSpec(resource_path="out.txt",
                     virtual="/out.txt",
                     directory="/")
    await write(accessor, scope, data=b"written")
    assert (tmp_path / "out.txt").read_bytes() == b"written"
