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
from mirage.commands.builtin.postgres.grep import grep
from mirage.commands.builtin.postgres.rg import rg
from mirage.commands.builtin.postgres.tail import tail
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.resource.postgres.config import PostgresConfig
from mirage.types import PathSpec

CONCRETE = "/public/tables/books/rows.jsonl"
GLOB = "/public/tables/*/rows.jsonl"


@pytest.fixture
def accessor():
    return PostgresAccessor(config=PostgresConfig(
        dsn="postgres://u:p@localhost:5432/db"))


def _glob_path() -> PathSpec:
    # The dispatcher hands a glob operand through with the trailing segment
    # in `pattern` and the wildcard still in `directory`; detect_scope would
    # otherwise read the "*" as an entity literally named "*".
    return PathSpec(virtual=GLOB,
                    directory="/public/tables",
                    resource_path=GLOB.strip("/"),
                    pattern="rows.jsonl",
                    resolved=False)


def _resolved_pair() -> list[PathSpec]:
    return [
        PathSpec(virtual=p,
                 directory="/public/tables",
                 resource_path=p.strip("/")) for p in (
                     "/public/tables/authors/rows.jsonl",
                     "/public/tables/books/rows.jsonl",
                 )
    ]


@pytest.mark.asyncio
async def test_grep_glob_skips_pushdown_and_expands(accessor):
    seen: dict[str, object] = {}

    async def fake_resolve(_accessor, _paths, index=None):
        return _resolved_pair()

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            "mirage.commands.builtin.postgres.grep.search_entity",
            new=AsyncMock(side_effect=AssertionError("pushdown ran on glob")),
    ), patch(
            "mirage.commands.builtin.postgres.grep._stat",
            new=AsyncMock(side_effect=AssertionError("stat ran on glob")),
    ), patch(
            "mirage.commands.builtin.postgres.grep.resolve_glob",
            new=fake_resolve,
    ), patch(
            "mirage.commands.builtin.postgres.grep.generic_grep",
            new=fake_generic,
    ):
        _, io = await grep(accessor, [_glob_path()], ['ada'],
                           CommandOpts(index=NULL_INDEX))

    assert io.exit_code == 0
    assert seen["generic"] == [
        "/public/tables/authors/rows.jsonl",
        "/public/tables/books/rows.jsonl",
    ]


@pytest.mark.asyncio
async def test_grep_concrete_path_still_uses_pushdown(accessor):
    search = AsyncMock(return_value=[])
    with patch(
            "mirage.commands.builtin.postgres.grep.search_entity",
            new=search,
    ), patch(
            "mirage.commands.builtin.postgres.grep._stat",
            new=AsyncMock(),
    ), patch(
            "mirage.commands.builtin.postgres.grep.resolve_glob",
            new=AsyncMock(side_effect=AssertionError("glob ran")),
    ):
        _, io = await grep(accessor, [
            PathSpec(virtual=CONCRETE,
                     directory='/public/tables/books',
                     resource_path=CONCRETE.strip('/'))
        ], ['ada'], CommandOpts(index=NULL_INDEX))

    assert io.exit_code == 1
    search.assert_awaited_once()


def _concrete_path() -> PathSpec:
    return PathSpec(virtual=CONCRETE,
                    directory="/public/tables/books",
                    resource_path=CONCRETE.strip("/"))


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [
    {
        "v": True
    },
    {
        "c": True
    },
    {
        "args_l": True
    },
    {
        "n": True
    },
])
async def test_grep_shaping_flag_skips_pushdown(accessor, flags):
    # A shaping flag cannot be honored by the ILIKE push-down (which prints
    # whole matching rows), so the wrapper must defer to the generic scan.
    seen: dict[str, object] = {}

    async def fake_resolve(_accessor, _paths, index=None):
        return [_concrete_path()]

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            "mirage.commands.builtin.postgres.grep.search_entity",
            new=AsyncMock(side_effect=AssertionError("pushdown ran w/ flag")),
    ), patch(
            "mirage.commands.builtin.postgres.grep.resolve_glob",
            new=fake_resolve,
    ), patch(
            "mirage.commands.builtin.postgres.grep.generic_grep",
            new=fake_generic,
    ):
        await grep(accessor, [_concrete_path()], ['ada'],
                   CommandOpts(index=NULL_INDEX, flags={**flags}))

    assert seen["generic"] == [CONCRETE]


@pytest.mark.asyncio
async def test_grep_regex_pattern_skips_pushdown(accessor):
    # A pattern with regex meaning is matched literally by ILIKE, so it must
    # take the generic scan rather than silently mis-matching.
    seen: dict[str, object] = {}

    async def fake_resolve(_accessor, _paths, index=None):
        return [_concrete_path()]

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            "mirage.commands.builtin.postgres.grep.search_entity",
            new=AsyncMock(side_effect=AssertionError("pushdown ran on regex")),
    ), patch(
            "mirage.commands.builtin.postgres.grep.resolve_glob",
            new=fake_resolve,
    ), patch(
            "mirage.commands.builtin.postgres.grep.generic_grep",
            new=fake_generic,
    ):
        await grep(accessor, [_concrete_path()], ['a.b'],
                   CommandOpts(index=NULL_INDEX))

    assert seen["generic"] == [CONCRETE]


@pytest.mark.asyncio
async def test_rg_glob_skips_pushdown_and_expands(accessor):
    seen: dict[str, object] = {}

    async def fake_resolve(_accessor, _paths, index=None):
        return _resolved_pair()

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            "mirage.commands.builtin.postgres.rg.search_entity",
            new=AsyncMock(side_effect=AssertionError("pushdown ran on glob")),
    ), patch(
            "mirage.commands.builtin.postgres.rg._stat",
            new=AsyncMock(side_effect=AssertionError("stat ran on glob")),
    ), patch(
            "mirage.commands.builtin.postgres.rg.resolve_glob",
            new=fake_resolve,
    ), patch(
            "mirage.commands.builtin.postgres.rg.generic_rg",
            new=fake_generic,
    ):
        _, io = await rg(accessor, [_glob_path()], ['ada'],
                         CommandOpts(index=NULL_INDEX))

    assert io.exit_code == 0
    assert seen["generic"] == [
        "/public/tables/authors/rows.jsonl",
        "/public/tables/books/rows.jsonl",
    ]


@pytest.mark.asyncio
async def test_tail_glob_does_not_query_a_relation_named_star(accessor):
    # Before the fix this reached count_rows with entity="*" and surfaced
    # 'relation "public.*" does not exist' to the user.
    async def fake_resolve(_accessor, _paths, index=None):
        return _resolved_pair()

    async def fake_generic(paths, _texts, _opts, _stat, _stream):
        return b"", IOResult()

    with patch(
            "mirage.commands.builtin.postgres.tail._client.count_rows",
            new=AsyncMock(side_effect=AssertionError("pushdown ran on glob")),
    ), patch(
            "mirage.commands.builtin.postgres.tail.resolve_or_empty",
            new=lambda _ops, _accessor, _paths, _index: fake_resolve(
                _accessor, _paths),
    ), patch(
            "mirage.commands.builtin.postgres.tail.tail_generic",
            new=fake_generic,
    ):
        _, io = await tail(accessor, [_glob_path()], [],
                           CommandOpts(index=NULL_INDEX, flags={'n': '1'}))

    assert io.exit_code == 0
