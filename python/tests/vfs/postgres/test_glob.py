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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.vfs.postgres import PostgresVFS
from mirage.vfs.postgres.config import PostgresConfig
from tests.fixtures.vfs_io import io_for


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def accessor():
    return PostgresAccessor(PostgresConfig(dsn="postgres://localhost/db"))


@pytest.mark.asyncio
async def test_resolve_glob_unresolved_no_pattern(accessor, index):
    p = PathSpec(
        vfs_path="public/tables",
        virtual="/public/tables",
        directory="/public",
        resolved=False,
        pattern=None,
    )
    result = await io_for(PostgresVFS, accessor).resolve_glob(
        accessor, [p], index
    )
    assert result == [p]
