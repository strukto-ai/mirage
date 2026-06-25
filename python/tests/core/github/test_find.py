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

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.find import find
from mirage.types import PathSpec


def _index() -> RAMIndexCacheStore:
    index = RAMIndexCacheStore()
    index._entries.update({
        "/src":
        IndexEntry(id="a", name="src", resource_type="folder", size=None),
        "/src/main.py":
        IndexEntry(id="b", name="main.py", resource_type="file", size=120),
        "/src/utils":
        IndexEntry(id="c", name="utils", resource_type="folder", size=None),
        "/src/utils/helpers.py":
        IndexEntry(id="d", name="helpers.py", resource_type="file", size=80),
        "/README.md":
        IndexEntry(id="e", name="README.md", resource_type="file", size=50),
    })
    return index


def _spec(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(original=path, directory=path, prefix=prefix)


@pytest.mark.asyncio
async def test_find_all_from_root():
    results = await find(None, _spec("/"), index=_index())
    assert results == [
        "/", "/README.md", "/src", "/src/main.py", "/src/utils",
        "/src/utils/helpers.py"
    ]


@pytest.mark.asyncio
async def test_find_name_pattern():
    results = await find(None, _spec("/"), name="*.py", index=_index())
    assert results == ["/src/main.py", "/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_find_type_directory():
    results = await find(None, _spec("/src"), type="d", index=_index())
    assert results == ["/src", "/src/utils"]


@pytest.mark.asyncio
async def test_find_type_file_under_subdir():
    results = await find(None, _spec("/src"), type="f", index=_index())
    assert results == ["/src/main.py", "/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_find_maxdepth():
    results = await find(None, _spec("/src"), maxdepth=1, index=_index())
    assert results == ["/src", "/src/main.py", "/src/utils"]


@pytest.mark.asyncio
async def test_find_mindepth():
    results = await find(None, _spec("/src"), mindepth=2, index=_index())
    assert results == ["/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_find_strips_mount_prefix():
    results = await find(None,
                         _spec("/github/src", prefix="/github"),
                         type="f",
                         index=_index())
    assert results == ["/src/main.py", "/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_find_size_filters():
    results = await find(None, _spec("/"), min_size=100, index=_index())
    assert results == ["/", "/src/main.py"]


@pytest.mark.asyncio
async def test_find_no_index_raises():
    with pytest.raises(ValueError):
        await find(None, _spec("/"), index=None)
