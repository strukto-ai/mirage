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
from mirage.ops.gdrive.read.read_orc import read_orc
from mirage.types import PathSpec
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
async def test_read_orc_calls_core(accessor, index):
    fn = read_orc._registered_ops[0].fn
    with patch(
            "mirage.ops.gdrive.read.read_orc.core_read",
            new_callable=AsyncMock,
            return_value=b"raw-orc",
    ) as mock_read, patch(
            "mirage.ops.gdrive.read.read_orc.orc_cat",
            return_value=b"csv-output",
    ) as mock_cat:
        result = await fn(accessor, _scope("/data/file.orc"), index=index)
        mock_read.assert_called_once_with(accessor, _scope("/data/file.orc"),
                                          index)
        mock_cat.assert_called_once_with(b"raw-orc")
        assert result == b"csv-output"
