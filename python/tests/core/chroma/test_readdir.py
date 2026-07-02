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

from mirage.core.chroma.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_readdir_root_lists_top_level(chroma_accessor, chroma_index,
                                            knowledge_root):
    entries = await readdir(chroma_accessor, knowledge_root, chroma_index)
    assert sorted(entries) == ["/knowledge/api", "/knowledge/guides"]


@pytest.mark.asyncio
async def test_readdir_subdir(chroma_accessor, chroma_index):
    path = PathSpec.from_str_path("/knowledge/guides",
                                  mount_key("/knowledge/guides", "/knowledge"))
    entries = await readdir(chroma_accessor, path, chroma_index)
    assert entries == ["/knowledge/guides/quickstart"]


@pytest.mark.asyncio
async def test_readdir_on_file_raises(chroma_accessor, chroma_index,
                                      quickstart_path):
    with pytest.raises(NotADirectoryError):
        await readdir(chroma_accessor, quickstart_path, chroma_index)
