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
from mirage.ops.gdrive import OPS
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _op(name: str):
    return next(o.fn for o in OPS if o.name == name and o.filetype is None)


readdir = _op("readdir")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path.rsplit("/", 1)[0] or "/")


@pytest.fixture
def accessor():
    return GDriveAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_serves_cached_listing(accessor, index):
    entry = IndexEntry(
        id="file123",
        name="readme",
        resource_type="gdrive/file",
        remote_time="2026-04-01T00:00:00Z",
        vfs_name="readme.txt",
    )
    await index.set_dir("/docs", [("readme.txt", entry)])
    result = await readdir(accessor, _scope("/docs"), index=index)
    assert result == ["/docs/readme.txt"]
