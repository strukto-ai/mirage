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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.ops.gdrive.stat import stat
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mount_key


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
async def test_stat_calls_core(accessor, index):
    fn = stat._registered_ops[0].fn
    fake_stat = FileStat(name="readme.txt", size=50)
    with patch(
            "mirage.ops.gdrive.stat.core_stat",
            new_callable=AsyncMock,
            return_value=fake_stat,
    ) as mock:
        result = await fn(accessor, _scope("/docs/readme.txt"), index=index)
        mock.assert_called_once_with(accessor, _scope("/docs/readme.txt"),
                                     index)
        assert result == fake_stat
