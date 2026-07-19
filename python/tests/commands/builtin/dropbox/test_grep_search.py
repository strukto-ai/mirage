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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.dropbox.grep import grep
from mirage.core.dropbox._client import DropboxTokenManager
from mirage.io.types import IOResult
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec

_GLOBALS = grep.__wrapped__.__globals__


def make_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           content_search=True)
    return DropboxAccessor(config, DropboxTokenManager(config))


def scope() -> PathSpec:
    return PathSpec(resource_path="", virtual="/data", directory="/data")


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def harness(monkeypatch):
    narrow = AsyncMock(return_value=([], False))
    generic = AsyncMock(return_value=(b"", IOResult()))
    monkeypatch.setitem(_GLOBALS, "narrow_scope", narrow)
    monkeypatch.setitem(_GLOBALS, "generic_grep", generic)
    return narrow, generic


@pytest.mark.asyncio
async def test_plain_recursive_grep_allows_narrowing(harness, index):
    narrow, _ = harness
    await grep(make_accessor(), [scope()], "needle", r=True, index=index)
    kwargs = narrow.await_args.kwargs
    assert kwargs["recursive"]
    assert not kwargs["exact_file_set"]
    assert not kwargs["fixed_string"]


@pytest.mark.asyncio
async def test_invert_forces_the_full_walk(harness, index):
    narrow, _ = harness
    await grep(make_accessor(), [scope()],
               "needle",
               r=True,
               v=True,
               index=index)
    assert narrow.await_args.kwargs["exact_file_set"]


@pytest.mark.asyncio
async def test_count_forces_the_full_walk(harness, index):
    narrow, _ = harness
    await grep(make_accessor(), [scope()],
               "needle",
               r=True,
               c=True,
               index=index)
    assert narrow.await_args.kwargs["exact_file_set"]


@pytest.mark.asyncio
async def test_narrowed_files_reach_the_generic_grep(harness, index):
    narrow, generic = harness
    hits = [
        PathSpec(resource_path="a.txt",
                 virtual="/data/a.txt",
                 directory="",
                 resolved=True)
    ]
    narrow.return_value = (hits, True)
    await grep(make_accessor(), [scope()], "needle", r=True, index=index)
    assert generic.await_args.args[0] == hits


@pytest.mark.asyncio
async def test_empty_narrowed_set_exits_one_without_reading(harness, index):
    narrow, generic = harness
    narrow.return_value = ([], True)
    stdout, io = await grep(make_accessor(), [scope()],
                            "needle",
                            r=True,
                            index=index)
    assert stdout == b""
    assert io.exit_code == 1
    generic.assert_not_awaited()
