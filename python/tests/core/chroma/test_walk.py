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

from mirage.core.chroma.walk import walk
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_walk_recurses_all(chroma_accessor, chroma_index,
                                 knowledge_root):
    results = await walk(chroma_accessor, knowledge_root, chroma_index)
    assert "/knowledge/guides/quickstart" in results
    assert "/knowledge/api/reference" in results
    assert "/knowledge/guides" in results


@pytest.mark.asyncio
async def test_walk_include_root(chroma_accessor, chroma_index,
                                 knowledge_root):
    results = await walk(chroma_accessor,
                         knowledge_root,
                         chroma_index,
                         include_root=True)
    assert results[0] == "/knowledge"


@pytest.mark.asyncio
async def test_walk_maxdepth_limits(chroma_accessor, chroma_index,
                                    knowledge_root):
    results = await walk(chroma_accessor,
                         knowledge_root,
                         chroma_index,
                         maxdepth=1)
    assert "/knowledge/guides" in results
    assert "/knowledge/guides/quickstart" not in results


@pytest.mark.asyncio
async def test_walk_strip_prefix(chroma_accessor, chroma_index,
                                 knowledge_root):
    results = await walk(chroma_accessor,
                         knowledge_root,
                         chroma_index,
                         strip_prefix=True)
    assert all(not item.startswith("/knowledge") for item in results)


@pytest.mark.asyncio
async def test_walk_missing_raises(chroma_accessor, chroma_index):
    path = PathSpec.from_str_path(
        "/knowledge/missing", mount_key("/knowledge/missing", "/knowledge"))
    with pytest.raises(FileNotFoundError):
        await walk(chroma_accessor, path, chroma_index)


@pytest.mark.asyncio
async def test_walk_missing_ignored(chroma_accessor, chroma_index):
    path = PathSpec.from_str_path(
        "/knowledge/missing", mount_key("/knowledge/missing", "/knowledge"))
    results = await walk(chroma_accessor,
                         path,
                         chroma_index,
                         ignore_missing=True)
    assert results == []
