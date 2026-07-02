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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.gdrive._provision import file_read_provision
from mirage.provision.types import Precision
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GDriveAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    store = RAMIndexCacheStore()
    return store


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.mark.asyncio
async def test_plan_returns_read_ops(accessor, index):
    await index.put(
        "/test/file.txt",
        IndexEntry(
            id="file123",
            name="file.txt",
            resource_type="gdrive/file",
            remote_time="2026-01-01T00:00:00Z",
            vfs_name="file.txt",
            size=500,
        ))
    result = await file_read_provision(
        accessor,
        [_scope("/test/file.txt")],
        "cat test/file.txt",
        index=index,
    )
    assert result.read_ops == 1
    assert result.precision == Precision.EXACT


@pytest.mark.asyncio
async def test_plan_no_paths(accessor, index):
    result = await file_read_provision(accessor, [], "cat", index=index)
    assert result.precision == Precision.UNKNOWN
    assert result.network_read_low == 0
    assert result.network_read_high == 0


@pytest.mark.asyncio
async def test_plan_missing_entry(accessor, index):
    result = await file_read_provision(
        accessor,
        [_scope("/nonexistent/path.txt")],
        "cat nonexistent/path.txt",
        index=index,
    )
    assert result.network_read_low == 0
    assert result.network_read_high == 0
    assert result.read_ops == 0
