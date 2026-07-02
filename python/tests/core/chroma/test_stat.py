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

from mirage.core.chroma.stat import stat, stat_name
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_stat_file(chroma_accessor, chroma_index, quickstart_path):
    result = await stat(chroma_accessor, quickstart_path, chroma_index)
    assert result.type == FileType.TEXT
    assert result.name == "quickstart"
    assert result.size == 12
    assert result.modified == "2026-02-01T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_directory(chroma_accessor, chroma_index):
    path = PathSpec.from_str_path("/knowledge/guides",
                                  mount_key("/knowledge/guides", "/knowledge"))
    result = await stat(chroma_accessor, path, chroma_index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "guides"


@pytest.mark.asyncio
async def test_stat_missing_raises(chroma_accessor, chroma_index):
    path = PathSpec.from_str_path(
        "/knowledge/missing", mount_key("/knowledge/missing", "/knowledge"))
    with pytest.raises(FileNotFoundError):
        await stat(chroma_accessor, path, chroma_index)


def test_stat_name_root():
    assert stat_name("/knowledge", "/knowledge/") == "/"


def test_stat_name_nested():
    assert stat_name("/knowledge/guides", "/knowledge/") == "guides"
