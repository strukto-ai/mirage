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

from mirage.core.chroma.glob import resolve_glob
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_plain_path_passes_through(chroma_accessor, chroma_index,
                                         quickstart_path):
    result = await resolve_glob(chroma_accessor, [quickstart_path],
                                chroma_index)
    assert result == [quickstart_path]


@pytest.mark.asyncio
async def test_pattern_expands_against_readdir(chroma_accessor, chroma_index):
    pattern = PathSpec(resource_path=mount_key("/knowledge/guides/quick*",
                                               "/knowledge"),
                       virtual="/knowledge/guides/quick*",
                       directory="/knowledge/guides",
                       pattern="quick*",
                       resolved=False)
    result = await resolve_glob(chroma_accessor, [pattern], chroma_index)
    assert [p.virtual for p in result] == ["/knowledge/guides/quickstart"]


@pytest.mark.asyncio
async def test_pattern_without_match_expands_to_nothing(
        chroma_accessor, chroma_index):
    pattern = PathSpec(resource_path=mount_key("/knowledge/guides/*.zip",
                                               "/knowledge"),
                       virtual="/knowledge/guides/*.zip",
                       directory="/knowledge/guides",
                       pattern="*.zip",
                       resolved=False)
    result = await resolve_glob(chroma_accessor, [pattern], chroma_index)
    assert result == []
