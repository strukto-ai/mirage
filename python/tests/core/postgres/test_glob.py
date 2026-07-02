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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.postgres.glob import resolve_glob
from mirage.resource.postgres.config import PostgresConfig
from mirage.types import PathSpec


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def accessor():
    return PostgresAccessor(PostgresConfig(dsn="postgres://localhost/db"))


@pytest.mark.asyncio
async def test_resolve_glob_str_path(accessor, index):
    result = await resolve_glob(accessor, ["/public/tables/users"], index)
    assert len(result) == 1
    assert result[0].virtual == "/public/tables/users"


@pytest.mark.asyncio
async def test_resolve_glob_resolved_pathspec(accessor, index):
    p = PathSpec(resource_path=("/public/tables/users").strip("/"),
                 virtual="/public/tables/users",
                 directory="/public/tables",
                 resolved=True)
    result = await resolve_glob(accessor, [p], index)
    assert result == [p]


@pytest.mark.asyncio
async def test_resolve_glob_pattern_match(accessor, index):
    with patch("mirage.core.postgres.glob.readdir",
               new_callable=AsyncMock,
               return_value=[
                   "/public/tables/users", "/public/tables/orders",
                   "/public/tables/teams"
               ]):
        p = PathSpec(resource_path=("/public/tables/u*").strip("/"),
                     virtual="/public/tables/u*",
                     directory="/public/tables",
                     pattern="u*",
                     resolved=False)
        result = await resolve_glob(accessor, [p], index)
    assert len(result) == 1
    assert result[0].virtual == "/public/tables/users"


@pytest.mark.asyncio
async def test_resolve_glob_unresolved_no_pattern(accessor, index):
    p = PathSpec(resource_path=("/public/tables").strip("/"),
                 virtual="/public/tables",
                 directory="/public",
                 resolved=False,
                 pattern=None)
    result = await resolve_glob(accessor, [p], index)
    assert result == [p]
