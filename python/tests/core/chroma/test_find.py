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

from mirage.core.chroma.find import find
from mirage.types import FindType


@pytest.mark.asyncio
async def test_find_all(chroma_accessor, chroma_index, knowledge_root):
    results = await find(chroma_accessor, knowledge_root, index=chroma_index)
    assert "guides/quickstart" in results
    assert "api/reference" in results
    assert "guides" in results


@pytest.mark.asyncio
async def test_find_name_matches_mount_root_start_path(chroma_accessor,
                                                       chroma_index,
                                                       knowledge_root):
    results = await find(chroma_accessor,
                         knowledge_root,
                         name="knowledge",
                         index=chroma_index)
    assert results == ["/knowledge"]


@pytest.mark.asyncio
async def test_find_by_name(chroma_accessor, chroma_index, knowledge_root):
    results = await find(chroma_accessor,
                         knowledge_root,
                         name="quick*",
                         index=chroma_index)
    assert results == ["guides/quickstart"]


@pytest.mark.asyncio
async def test_find_type_file(chroma_accessor, chroma_index, knowledge_root):
    results = await find(chroma_accessor,
                         knowledge_root,
                         type=FindType.FILE,
                         index=chroma_index)
    assert sorted(results) == ["api/reference", "guides/quickstart"]


@pytest.mark.asyncio
async def test_find_type_directory(chroma_accessor, chroma_index,
                                   knowledge_root):
    results = await find(chroma_accessor,
                         knowledge_root,
                         type=FindType.DIRECTORY,
                         index=chroma_index)
    assert "guides" in results
    assert "guides/quickstart" not in results


@pytest.mark.asyncio
async def test_find_iname_case_insensitive(chroma_accessor, chroma_index,
                                           knowledge_root):
    results = await find(chroma_accessor,
                         knowledge_root,
                         iname="QUICK*",
                         index=chroma_index)
    assert results == ["guides/quickstart"]


@pytest.mark.asyncio
async def test_find_missing_index_raises(chroma_accessor, knowledge_root):
    with pytest.raises(ValueError, match="missing index"):
        await find(chroma_accessor, knowledge_root, index=None)
