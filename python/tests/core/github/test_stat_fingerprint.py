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

from datetime import datetime, timedelta, timezone

import pytest

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.stat import stat
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_github_stat_returns_fingerprint_from_blob_sha():
    index = RAMIndexCacheStore()
    entry = IndexEntry(
        id="abc123",
        name="main.py",
        resource_type="file",
        size=42,
    )
    index._entries["/src/main.py"] = entry
    index._children["/src"] = ["/src/main.py"]
    index._expiry["/src"] = datetime.now(timezone.utc) + timedelta(days=365)

    result = await stat(
        None,
        PathSpec(resource_path="src/main.py",
                 virtual="/src/main.py",
                 directory="/src/main.py"),
        index,
    )

    assert result.fingerprint == "abc123"
    assert result.extra == {"sha": "abc123"}


@pytest.mark.asyncio
async def test_github_stat_directory_has_no_fingerprint():
    index = RAMIndexCacheStore()
    entry = IndexEntry(
        id="dir_sha",
        name="src",
        resource_type="folder",
    )
    index._entries["/src"] = entry

    result = await stat(
        None,
        PathSpec(resource_path="src", virtual="/src", directory="/src"),
        index,
    )

    assert result.fingerprint is None
