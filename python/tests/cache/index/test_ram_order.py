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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.types import FileStat, FileType


@pytest.mark.asyncio
async def test_set_dir_preserves_insertion_order():
    store = RAMIndexCacheStore(ttl=60)
    entries = [
        (
            "2026-05-03_zebra__id3.gdoc.json",
            FileStat(name="zebra", type=FileType.FILE, fingerprint="3"),
        ),
        (
            "2026-05-02_apple__id2.gdoc.json",
            FileStat(name="apple", type=FileType.FILE, fingerprint="2"),
        ),
        (
            "2026-05-01_mango__id1.gdoc.json",
            FileStat(name="mango", type=FileType.FILE, fingerprint="1"),
        ),
    ]
    await store.set_dir("/gdocs/owned", entries)
    result = await store.list_dir("/gdocs/owned")
    assert result.entries == [
        "/gdocs/owned/2026-05-03_zebra__id3.gdoc.json",
        "/gdocs/owned/2026-05-02_apple__id2.gdoc.json",
        "/gdocs/owned/2026-05-01_mango__id1.gdoc.json",
    ]
