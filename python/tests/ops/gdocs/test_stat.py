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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.ops.gdocs import OPS
from mirage.ops.registry import RegisteredOp
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _op(name: str):
    for o in OPS:
        registered = [o] if isinstance(o, RegisteredOp) else o._registered_ops
        for ro in registered:
            if ro.name == name and ro.filetype is None:
                return ro.fn
    raise KeyError(name)


stat = _op("stat")


def _scope(path: str, prefix: str = "/gdocs") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    return GDocsAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root_is_directory(accessor, index):
    result = await stat(accessor, _scope("/gdocs"), index=index)
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_doc(accessor, index):
    await index.put(
        "/gdocs/owned/file.gdoc.json",
        IndexEntry(
            id="doc1",
            name="Report",
            resource_type="gdocs/doc",
            remote_time="2026-04-01T00:00:00Z",
            vfs_name="file.gdoc.json",
        ))
    result = await stat(accessor,
                        _scope("/gdocs/owned/file.gdoc.json"),
                        index=index)
    assert result.name == "file.gdoc.json"
    assert result.extra["doc_id"] == "doc1"


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    await index.set_dir("/gdocs/owned", [])
    with pytest.raises(FileNotFoundError):
        await stat(accessor,
                   _scope("/gdocs/owned/nonexistent.gdoc.json"),
                   index=index)
