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

from mirage.cache.index.ram import ListingCheckStore
from mirage.core.chroma.stat import stat
from mirage.types import ContentType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.chroma import ChromaVFS
from tests.fixtures.mounted import Mounted


@pytest.mark.asyncio
async def test_stat_file(chroma_accessor, quickstart_path):
    mount = Mounted(ChromaVFS, chroma_accessor, "/knowledge")
    result = await mount.stat(quickstart_path)
    assert result.content == ContentType.TEXT
    assert result.name == "quickstart"
    assert result.size == 12
    assert result.modified == "2026-02-01T00:00:00Z"


@pytest.mark.asyncio
async def test_a_fresh_check_reads_the_row_from_the_tree(
    chroma_accessor, quickstart_path
):
    # A fresh check is handed no row: the stat asks the collection.
    result = await stat(
        chroma_accessor, quickstart_path, None, ListingCheckStore()
    )
    assert [result.name, result.size] == ["quickstart", 12]
    missing = PathSpec.from_str_path(
        "/knowledge/guides/nope",
        mount_key("/knowledge/guides/nope", "/knowledge"),
    )
    with pytest.raises(FileNotFoundError):
        await stat(chroma_accessor, missing, None, ListingCheckStore())
