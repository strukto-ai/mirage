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
from mirage.core.disk.constants import SCOPE_ERROR
from mirage.core.disk.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.glob_walk import make_resolve_glob

resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR)


@pytest.mark.asyncio
async def test_resolve_file_path(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path="a.txt",
                     virtual="/a.txt",
                     directory="/",
                     resolved=True)
    result = await resolve_glob(accessor, [scope], index)
    assert len(result) == 1
    assert result[0].virtual == "/a.txt"
    assert result[0].resolved is True


@pytest.mark.asyncio
async def test_resolve_glob_pattern(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "b.txt").write_text("b")
    (tmp_path / "c.py").write_text("c")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path="*.txt",
                     virtual="/*.txt",
                     directory="/",
                     pattern="*.txt",
                     resolved=False)
    result = await resolve_glob(accessor, [scope], index)
    originals = sorted(r.virtual for r in result)
    assert originals == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_resolve_directory_path(tmp_path):
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path="",
                     virtual="/",
                     directory="/",
                     resolved=False)
    result = await resolve_glob(accessor, [scope], index)
    assert len(result) == 1
    assert result[0].virtual == "/"
