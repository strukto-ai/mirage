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
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.postgres.rg import rg
from mirage.io.types import IOResult
from mirage.resource.postgres.config import PostgresConfig
from mirage.types import PathSpec


@pytest.fixture
def accessor():
    return PostgresAccessor(config=PostgresConfig(
        dsn="postgres://u:p@localhost:5432/db"))


def _path(s: str = "/public/tables/books/rows.jsonl") -> PathSpec:
    return PathSpec(virtual=s, directory=s, resource_path=s.strip("/"))


@pytest.mark.asyncio
async def test_rg_multi_pattern_skips_native_search(accessor):
    # A newline-joined multi -e set must bypass the native pushdown and
    # still resolve globs before the generic runs (#347).
    seen: dict[str, object] = {}

    async def fake_resolve(_accessor, paths, index=None):
        seen["resolved"] = [p.virtual for p in paths]
        return paths

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            "mirage.commands.builtin.postgres.rg.search_entity",
            new=AsyncMock(side_effect=AssertionError("native search ran")),
    ), patch(
            "mirage.commands.builtin.postgres.rg.resolve_glob",
            new=fake_resolve,
    ), patch(
            "mirage.commands.builtin.postgres.rg.generic_rg",
            new=fake_generic,
    ):
        _, io = await rg(accessor, [_path()],
                         index=NULL_INDEX,
                         e=["ada", "ben"])

    assert io.exit_code == 0
    assert seen["resolved"] == ["/public/tables/books/rows.jsonl"]
    assert seen["generic"] == ["/public/tables/books/rows.jsonl"]


@pytest.mark.asyncio
async def test_rg_single_pattern_uses_native_search(accessor):
    search = AsyncMock(return_value=[])
    with patch(
            "mirage.commands.builtin.postgres.rg.search_entity",
            new=search,
    ), patch(
            "mirage.commands.builtin.postgres.rg.resolve_glob",
            new=AsyncMock(side_effect=AssertionError("glob ran")),
    ):
        _, io = await rg(accessor, [_path()], "ada", index=NULL_INDEX)

    assert io.exit_code == 1
    search.assert_awaited_once()
