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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.langfuse.rg import rg
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.langfuse.config import LangfuseConfig

GENERICS = "mirage.commands.builtin.generic_bind.search._GENERICS"
RESOLVE = "mirage.commands.builtin.generic_bind.adapter.make_resolve_glob"

# The searchers live in the grep module and rg shares them, so the fetch
# fakes patch the names the searchers read at call time.
FETCH_TRACES = "mirage.commands.builtin.langfuse.grep.fetch_traces"
FETCH_SESSIONS = "mirage.commands.builtin.langfuse.grep.fetch_sessions"


@pytest.fixture
def accessor():
    return LangfuseAccessor(LangfuseConfig(public_key="pk", secret_key="sk"))


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    vfs_path=virtual.strip("/"))


def _glob(virtual: str) -> PathSpec:
    # A glob whose scope IS searchable, so only the glob half of the gate can
    # defer it: "/traces/*" routes to `invalid` and would defer regardless,
    # while "/sessions/*" routes to `session` and reaches the push-down.
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0],
                    vfs_path=virtual.strip("/"),
                    pattern=virtual.rsplit("/", 1)[-1],
                    resolved=False)


def _opts(**flags) -> CommandOpts:
    return CommandOpts(index=RAMIndexCacheStore(), flags={**flags})


async def _resolve_empty(_accessor, _paths, index=None):
    return []


def _fake_resolver(resolve):
    return lambda *_args, **_kwargs: resolve


SUMMARIES = [
    {
        "id": "t1",
        "name": "alpha search-me"
    },
    {
        "id": "t2",
        "name": "beta"
    },
]


@pytest.mark.asyncio
async def test_fast_path_matches_listing_summaries(accessor):
    with patch(FETCH_TRACES, new=AsyncMock(return_value=SUMMARIES)) as fetch:
        stdout, io = await rg(accessor, [_spec("/traces")], ["search-me"],
                              _opts())
    fetch.assert_awaited_once()
    text = (stdout if isinstance(stdout, bytes) else b"").decode()
    assert "traces/t1.json:" in text
    assert "t2" not in text
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_shaping_flag_defers_to_generic(accessor):
    generic = AsyncMock(return_value=(b"", IOResult()))
    with patch(FETCH_TRACES,
               new=AsyncMock(return_value=SUMMARIES)) as fetch, patch.dict(
                   GENERICS, {"rg": generic}):
        await rg(accessor, [_spec("/traces")], ["search-me"],
                 _opts(args_l=True))
    fetch.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_unresolved_glob_defers_to_generic(accessor):
    generic = AsyncMock(return_value=(b"", IOResult()))
    with patch(FETCH_SESSIONS, new=AsyncMock(return_value=[])) as fetch, patch(
            RESOLVE, new=_fake_resolver(_resolve_empty)), patch.dict(
                GENERICS, {"rg": generic}):
        await rg(accessor, [_glob("/sessions/*")], ["search-me"], _opts())
    fetch.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_second_operand_defers_to_generic(accessor):
    # The push-down answers for one container, so a second operand used to be
    # dropped in silence: this line reported traces and never mentioned
    # sessions at all.
    generic = AsyncMock(return_value=(b"", IOResult()))
    with patch(FETCH_TRACES,
               new=AsyncMock(return_value=SUMMARIES)) as fetch, patch.dict(
                   GENERICS, {"rg": generic}):
        await rg(accessor,
                 [_spec("/traces"), _spec("/sessions")], ["search-me"],
                 _opts())
    fetch.assert_not_awaited()
    generic.assert_awaited_once()


@pytest.mark.asyncio
async def test_repeated_operand_defers_to_generic(accessor):
    # Two operands in one family are the case a per-operand push-down would
    # get wrong: both route to "search every trace", so it would print the
    # whole container twice.
    generic = AsyncMock(return_value=(b"", IOResult()))
    with patch(FETCH_TRACES,
               new=AsyncMock(return_value=SUMMARIES)) as fetch, patch.dict(
                   GENERICS, {"rg": generic}):
        await rg(accessor,
                 [_spec("/traces"), _spec("/traces")], ["search-me"], _opts())
    fetch.assert_not_awaited()
    generic.assert_awaited_once()
