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

from mirage.accessor.box import BoxAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.box.narrow import narrow_scope
from mirage.core.box._client import BoxTokenManager
from mirage.core.box.config import BoxConfig
from mirage.types import FileStat, FileType, PathSpec

_NGLOBALS = narrow_scope.__globals__

DIR_STAT = FileStat(name="data", type=FileType.DIRECTORY)
FILE_STAT = FileStat(name="x.txt", type=FileType.TEXT)


def make_accessor(content_search: bool = True) -> BoxAccessor:
    config = BoxConfig(access_token="tok", content_search=content_search)
    return BoxAccessor(config, BoxTokenManager(config))


def scope() -> PathSpec:
    return PathSpec(resource_path="", virtual="/data", directory="/data")


def spec(virtual: str) -> PathSpec:
    return PathSpec(resource_path=virtual.removeprefix("/data/"),
                    virtual=virtual,
                    directory="",
                    resolved=True)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def harness(monkeypatch):
    stat = AsyncMock(return_value=DIR_STAT)
    narrow = AsyncMock(return_value=[spec("/data/a.txt")])
    glob = AsyncMock(return_value=[scope()])
    monkeypatch.setitem(_NGLOBALS, "box_stat", stat)
    monkeypatch.setitem(_NGLOBALS, "narrow_paths", narrow)
    monkeypatch.setitem(_NGLOBALS, "resolve_glob", glob)
    return stat, narrow, glob


async def run(index, **kwargs):
    defaults = {
        "fixed_string": False,
        "recursive": True,
        "exact_file_set": False,
    }
    defaults.update(kwargs)
    return await narrow_scope(make_accessor(), index, [scope()], "needle",
                              **defaults)


@pytest.mark.asyncio
async def test_narrows_recursive_literal_scans(harness, index):
    _, narrow, glob = harness
    resolved, used = await run(index)
    assert used
    assert [p.virtual for p in resolved] == ["/data/a.txt"]
    narrow.assert_awaited_once()
    glob.assert_not_awaited()


@pytest.mark.asyncio
async def test_knob_off_skips_search(harness, index):
    _, narrow, glob = harness
    resolved, used = await narrow_scope(make_accessor(content_search=False),
                                        index, [scope()],
                                        "needle",
                                        fixed_string=False,
                                        recursive=True,
                                        exact_file_set=False)
    assert not used
    narrow.assert_not_awaited()
    glob.assert_awaited_once()
    assert resolved == [scope()]


@pytest.mark.asyncio
async def test_non_recursive_skips_search(harness, index):
    _, narrow, _ = harness
    _, used = await run(index, recursive=False)
    assert not used
    narrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_exact_file_set_skips_search(harness, index):
    _, narrow, _ = harness
    _, used = await run(index, exact_file_set=True)
    assert not used
    narrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_multiline_pattern_skips_search(harness, index):
    _, narrow, _ = harness
    _, used = await narrow_scope(make_accessor(),
                                 index, [scope()],
                                 "foo\nbar",
                                 fixed_string=False,
                                 recursive=True,
                                 exact_file_set=False)
    assert not used
    narrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_regex_without_literal_skips_search(harness, index):
    _, narrow, _ = harness
    _, used = await narrow_scope(make_accessor(),
                                 index, [scope()],
                                 "foo|bar",
                                 fixed_string=False,
                                 recursive=True,
                                 exact_file_set=False)
    assert not used
    narrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_regex_narrows_on_required_literal(harness, index):
    _, narrow, _ = harness
    _, used = await narrow_scope(make_accessor(),
                                 index, [scope()],
                                 "import.*os",
                                 fixed_string=False,
                                 recursive=True,
                                 exact_file_set=False)
    assert used
    assert narrow.await_args.args[1] == "import"


@pytest.mark.asyncio
async def test_file_scope_skips_search(harness, index):
    stat, narrow, _ = harness
    stat.return_value = FILE_STAT
    _, used = await run(index)
    assert not used
    narrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_scope_skips_search(harness, index):
    stat, narrow, _ = harness
    stat.side_effect = FileNotFoundError("/data")
    _, used = await run(index)
    assert not used
    narrow.assert_not_awaited()


@pytest.mark.asyncio
async def test_unusable_narrow_falls_back_to_glob(harness, index):
    _, narrow, glob = harness
    narrow.return_value = None
    _, used = await run(index)
    assert not used
    glob.assert_awaited_once()


@pytest.mark.asyncio
async def test_empty_narrow_falls_back_to_glob(harness, index):
    _, narrow, glob = harness
    narrow.return_value = []
    _, used = await run(index)
    assert not used
    glob.assert_awaited_once()


@pytest.mark.asyncio
async def test_binary_candidates_are_dropped(harness, index):
    _, narrow, _ = harness
    narrow.return_value = [spec("/data/a.parquet"), spec("/data/a.txt")]
    resolved, used = await run(index)
    assert used
    assert [p.virtual for p in resolved] == ["/data/a.txt"]


@pytest.mark.asyncio
async def test_all_binary_narrow_stays_used_and_empty(harness, index):
    _, narrow, glob = harness
    narrow.return_value = [spec("/data/a.parquet")]
    resolved, used = await run(index)
    assert used
    assert resolved == []
    glob.assert_not_awaited()
