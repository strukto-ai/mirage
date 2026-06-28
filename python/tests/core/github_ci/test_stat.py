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

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github_ci.stat import stat
from mirage.resource.github_ci.config import GitHubCIConfig
from mirage.types import FileType, PathSpec


@pytest.fixture
def accessor():
    return GitHubCIAccessor(GitHubCIConfig(token="t", owner="o", repo="r"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


def _spec(original: str) -> PathSpec:
    return PathSpec(original=original, directory=original)


@pytest.mark.asyncio
async def test_stat_run_returns_modified(accessor, index):
    await index.put(
        "/runs/CI__123",
        IndexEntry(
            id="123",
            name="CI",
            resource_type="ci/run",
            remote_time="2026-04-05T00:00:00Z",
            vfs_name="CI__123",
        ),
    )
    result = await stat(accessor, _spec("/runs/CI__123"), index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["run_id"] == "123"
    assert result.modified == "2026-04-05T00:00:00Z"
