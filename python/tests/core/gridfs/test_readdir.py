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

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from bson import ObjectId

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gridfs.readdir import readdir
from mirage.types import PathSpec

_UPLOAD = datetime(2026, 1, 1, tzinfo=timezone.utc)


@pytest.fixture
def accessor():
    return GridFSAccessor(config=GridFSConfig(
        uri="mongodb://localhost:27017", database="db", bucket="data"))


def _doc(filename: str, length: int = 0) -> dict:
    return {
        "filename": filename,
        "_id": ObjectId(),
        "length": length,
        "uploadDate": _UPLOAD,
    }


def _fake_iter(docs):

    async def iter_latest(accessor, query):
        for doc in docs:
            yield doc

    return iter_latest


def _path(s: str) -> PathSpec:
    return PathSpec(virtual=s, directory=s, resource_path=s.strip("/"))


@pytest.mark.asyncio
async def test_readdir_derives_files_dirs_and_markers(accessor):
    docs = [
        _doc("a.txt", 3),
        _doc("empty/"),
        _doc("sub/b.csv", 7),
        _doc("sub/deep/c.txt", 1),
    ]
    with patch("mirage.core.gridfs.readdir.iter_latest", new=_fake_iter(docs)):
        entries = await readdir(accessor, _path("/"))
    assert entries == ["/a.txt", "/empty", "/sub"]


@pytest.mark.asyncio
async def test_readdir_skips_own_marker_and_dedupes(accessor):
    docs = [
        _doc("sub/"),
        _doc("sub/b.csv", 7),
        _doc("sub/deep/c.txt", 1),
        _doc("sub/deep/d.txt", 1),
    ]
    with patch("mirage.core.gridfs.readdir.iter_latest", new=_fake_iter(docs)):
        entries = await readdir(accessor, _path("/sub"))
    assert entries == ["/sub/b.csv", "/sub/deep"]


@pytest.mark.asyncio
async def test_readdir_populates_index(accessor):
    index = RAMIndexCacheStore()
    docs = [_doc("a.txt", 3), _doc("sub/b.csv", 7)]
    with patch("mirage.core.gridfs.readdir.iter_latest", new=_fake_iter(docs)):
        await readdir(accessor, _path("/"), index)
    lookup = await index.get("/a.txt")
    assert lookup.entry is not None
    assert lookup.entry.size == 3
    folder = await index.get("/sub")
    assert folder.entry is not None
