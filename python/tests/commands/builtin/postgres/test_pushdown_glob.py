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

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.postgres.grep import grep
from mirage.commands.builtin.postgres.rg import rg
from mirage.commands.builtin.postgres.tail import tail
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.postgres.config import PostgresConfig

CONCRETE = "/public/tables/books/rows.jsonl"
GLOB = "/public/tables/*/rows.jsonl"

GENERICS = "mirage.commands.builtin.generic_bind.search._GENERICS"
RESOLVE = "mirage.commands.builtin.generic_bind.adapter.make_resolve_glob"
SEARCH_ENTITY = "mirage.core.postgres.search.search_entity"


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


@pytest.fixture
def accessor():
    a = PostgresAccessor(config=PostgresConfig(
        dsn="postgres://u:p@localhost:5432/db"))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.fixture
def _guard_reads(monkeypatch):
    # The stat guard is captured by the search factory at import, so fake
    # what it reads at call time: the pool (above) and the client queries.
    monkeypatch.setattr("mirage.core.postgres.client.list_tables",
                        AsyncMock(return_value=["authors", "books"]))
    monkeypatch.setattr("mirage.core.postgres.client.list_views",
                        AsyncMock(return_value=[]))
    monkeypatch.setattr("mirage.core.postgres.client.list_matviews",
                        AsyncMock(return_value=[]))
    monkeypatch.setattr("mirage.core.postgres.client.fetch_columns",
                        AsyncMock(return_value=[]))
    monkeypatch.setattr("mirage.core.postgres.client.estimated_row_count",
                        AsyncMock(return_value=0))
    monkeypatch.setattr("mirage.core.postgres.client.table_size_bytes",
                        AsyncMock(return_value=0))


def _glob_path() -> PathSpec:
    # The dispatcher hands a glob operand through with the trailing segment
    # in `pattern` and the wildcard still in `directory`; detect_scope would
    # otherwise read the "*" as an entity literally named "*".
    return PathSpec(virtual=GLOB,
                    directory="/public/tables",
                    vfs_path=GLOB.strip("/"),
                    pattern="rows.jsonl",
                    resolved=False)


def _resolved_pair() -> list[PathSpec]:
    return [
        PathSpec(virtual=p, directory="/public/tables", vfs_path=p.strip("/"))
        for p in (
            "/public/tables/authors/rows.jsonl",
            "/public/tables/books/rows.jsonl",
        )
    ]


async def _resolve_pair(_accessor, _paths, index=None):
    return _resolved_pair()


def _fake_resolver(resolve):
    return lambda *_args, **_kwargs: resolve


@pytest.mark.asyncio
async def test_grep_glob_skips_pushdown_and_expands(accessor):
    seen: dict[str, object] = {}

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_ENTITY,
            new=AsyncMock(side_effect=AssertionError("pushdown ran on glob")),
    ), patch(
            RESOLVE,
            new=_fake_resolver(_resolve_pair),
    ), patch.dict(GENERICS, {"grep": fake_generic}):
        _, io = await grep(accessor, [_glob_path()], ['ada'],
                           CommandOpts(index=NULL_INDEX))

    assert io.exit_code == 0
    assert seen["generic"] == [
        "/public/tables/authors/rows.jsonl",
        "/public/tables/books/rows.jsonl",
    ]


@pytest.mark.asyncio
async def test_grep_concrete_path_still_uses_pushdown(accessor, _guard_reads):
    search = AsyncMock(return_value=[])
    with patch(
            SEARCH_ENTITY,
            new=search,
    ), patch(
            RESOLVE,
            new=_fake_resolver(
                AsyncMock(side_effect=AssertionError("glob ran"))),
    ):
        _, io = await grep(accessor, [
            PathSpec(virtual=CONCRETE,
                     directory='/public/tables/books',
                     vfs_path=CONCRETE.strip('/'))
        ], ['ada'], CommandOpts(index=NULL_INDEX))

    assert io.exit_code == 1
    search.assert_awaited_once()


def _concrete_path() -> PathSpec:
    return PathSpec(virtual=CONCRETE,
                    directory="/public/tables/books",
                    vfs_path=CONCRETE.strip("/"))


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

    async def _resolve_one(_accessor, _paths, index=None):
        return [_concrete_path()]

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_ENTITY,
            new=AsyncMock(side_effect=AssertionError("pushdown ran w/ flag")),
    ), patch(
            RESOLVE,
            new=_fake_resolver(_resolve_one),
    ), patch.dict(GENERICS, {"grep": fake_generic}):
        await grep(accessor, [_concrete_path()], ['ada'],
                   CommandOpts(index=NULL_INDEX, flags={**flags}))

    assert seen["generic"] == [CONCRETE]


@pytest.mark.asyncio
async def test_grep_regex_pattern_skips_pushdown(accessor):
    # A pattern with regex meaning is matched literally by ILIKE, so it must
    # take the generic scan rather than silently mis-matching.
    seen: dict[str, object] = {}

    async def _resolve_one(_accessor, _paths, index=None):
        return [_concrete_path()]

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_ENTITY,
            new=AsyncMock(side_effect=AssertionError("pushdown ran on regex")),
    ), patch(
            RESOLVE,
            new=_fake_resolver(_resolve_one),
    ), patch.dict(GENERICS, {"grep": fake_generic}):
        await grep(accessor, [_concrete_path()], ['a.b'],
                   CommandOpts(index=NULL_INDEX))

    assert seen["generic"] == [CONCRETE]


def _second_path() -> PathSpec:
    other = "/public/tables/authors/rows.jsonl"
    return PathSpec(virtual=other,
                    directory="/public/tables/authors",
                    vfs_path=other.strip("/"))


@pytest.mark.asyncio
async def test_grep_second_operand_skips_pushdown(accessor):
    # The push-down answers for one operand and printed nothing about the
    # rest, so a two-operand line silently reported only books.
    seen: dict[str, object] = {}

    async def _resolve_two(_accessor, _paths, index=None):
        return [_concrete_path(), _second_path()]

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_ENTITY,
            new=AsyncMock(side_effect=AssertionError("pushdown ran on 2 ops")),
    ), patch(
            RESOLVE,
            new=_fake_resolver(_resolve_two),
    ), patch.dict(GENERICS, {"grep": fake_generic}):
        await grep(accessor,
                   [_concrete_path(), _second_path()], ['ada'],
                   CommandOpts(index=NULL_INDEX))

    assert seen["generic"] == [CONCRETE, "/public/tables/authors/rows.jsonl"]


@pytest.mark.asyncio
async def test_rg_second_operand_skips_pushdown(accessor):
    seen: dict[str, object] = {}

    async def _resolve_two(_accessor, _paths, index=None):
        return [_concrete_path(), _second_path()]

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_ENTITY,
            new=AsyncMock(side_effect=AssertionError("pushdown ran on 2 ops")),
    ), patch(
            RESOLVE,
            new=_fake_resolver(_resolve_two),
    ), patch.dict(GENERICS, {"rg": fake_generic}):
        await rg(accessor, [_concrete_path(), _second_path()], ['ada'],
                 CommandOpts(index=NULL_INDEX))

    assert seen["generic"] == [CONCRETE, "/public/tables/authors/rows.jsonl"]


@pytest.mark.asyncio
async def test_rg_glob_skips_pushdown_and_expands(accessor):
    seen: dict[str, object] = {}

    async def fake_generic(paths, _texts, _flags, **_kwargs):
        seen["generic"] = [p.virtual for p in paths]
        return b"", IOResult()

    with patch(
            SEARCH_ENTITY,
            new=AsyncMock(side_effect=AssertionError("pushdown ran on glob")),
    ), patch(
            RESOLVE,
            new=_fake_resolver(_resolve_pair),
    ), patch.dict(GENERICS, {"rg": fake_generic}):
        _, io = await rg(accessor, [_glob_path()], ['ada'],
                         CommandOpts(index=NULL_INDEX))

    assert io.exit_code == 0
    assert seen["generic"] == [
        "/public/tables/authors/rows.jsonl",
        "/public/tables/books/rows.jsonl",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{"follow": True}, {"F": True}])
async def test_tail_follow_reads_the_relation_whole(accessor, flags):
    # A follow polls the file as it grows; the pushed-down suffix moves
    # with the table and has no byte position to measure against, so a
    # follow goes through tail_generic on the full stream.
    reached: list[list[PathSpec]] = []

    async def fake_generic(paths, _texts, _opts, _stat, _stream):
        reached.append(paths)
        return b"", IOResult()

    concrete = PathSpec(virtual=CONCRETE,
                        directory="/public/tables/books",
                        vfs_path=CONCRETE.strip("/"))
    with patch(
            "mirage.commands.builtin.postgres.tail.client.count_rows",
            new=AsyncMock(side_effect=AssertionError("pushdown ran under -f")),
    ), patch(
            "mirage.commands.builtin.postgres.tail.resolve_or_empty",
            new=AsyncMock(return_value=[concrete]),
    ), patch(
            "mirage.commands.builtin.postgres.tail.tail_generic",
            new=fake_generic,
    ):
        _, io = await tail(accessor, [concrete], [],
                           CommandOpts(index=NULL_INDEX, flags=flags))
    assert io.exit_code == 0
    assert reached == [[concrete]]


@pytest.mark.asyncio
async def test_tail_glob_does_not_query_a_relation_named_star(accessor):
    # Before the fix this reached count_rows with entity="*" and surfaced
    # 'relation "public.*" does not exist' to the user.
    async def fake_resolve(_accessor, _paths, index=None):
        return _resolved_pair()

    async def fake_generic(paths, _texts, _opts, _stat, _stream):
        return b"", IOResult()

    with patch(
            "mirage.commands.builtin.postgres.tail.client.count_rows",
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
