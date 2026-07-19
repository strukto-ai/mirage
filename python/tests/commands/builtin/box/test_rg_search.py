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
from mirage.commands.builtin.box.rg import _keep_visible, rg
from mirage.core.box._client import BoxTokenManager
from mirage.core.box.config import BoxConfig
from mirage.io.types import IOResult
from mirage.types import PathSpec

_GLOBALS = rg.__wrapped__.__globals__


def make_accessor() -> BoxAccessor:
    config = BoxConfig(access_token="tok", content_search=True)
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
    narrow = AsyncMock(return_value=([], False))
    generic = AsyncMock(return_value=(b"", IOResult()))
    monkeypatch.setitem(_GLOBALS, "narrow_scope", narrow)
    monkeypatch.setitem(_GLOBALS, "generic_rg", generic)
    return narrow, generic


def test_keep_visible_drops_dotfiles_below_the_scope():
    kept = _keep_visible(
        [spec("/data/.env"),
         spec("/data/.git/config"),
         spec("/data/a.txt")], [scope()],
        hidden=False)
    assert [p.virtual for p in kept] == ["/data/a.txt"]


def test_keep_visible_hidden_flag_keeps_everything():
    paths = [spec("/data/.env"), spec("/data/a.txt")]
    assert _keep_visible(paths, [scope()], hidden=True) == paths


def test_keep_visible_ignores_dots_in_the_scope_itself():
    hidden_scope = PathSpec(resource_path=".cfg",
                            virtual="/data/.cfg",
                            directory="/data/.cfg")
    kept = _keep_visible([spec("/data/.cfg/a.txt")], [hidden_scope],
                         hidden=False)
    assert [p.virtual for p in kept] == ["/data/.cfg/a.txt"]


@pytest.mark.asyncio
async def test_plain_rg_allows_narrowing(harness, index):
    narrow, _ = harness
    await rg(make_accessor(), [scope()], "needle", index=index)
    kwargs = narrow.await_args.kwargs
    assert kwargs["recursive"]
    assert not kwargs["exact_file_set"]


@pytest.mark.asyncio
async def test_invert_type_and_glob_force_the_full_walk(harness, index):
    narrow, _ = harness
    await rg(make_accessor(), [scope()], "needle", v=True, index=index)
    assert narrow.await_args.kwargs["exact_file_set"]
    await rg(make_accessor(), [scope()], "needle", type="py", index=index)
    assert narrow.await_args.kwargs["exact_file_set"]
    await rg(make_accessor(), [scope()], "needle", glob="*.py", index=index)
    assert narrow.await_args.kwargs["exact_file_set"]


@pytest.mark.asyncio
async def test_narrowed_run_forces_filename_labels(harness, index):
    narrow, generic = harness
    narrow.return_value = ([spec("/data/a.txt")], True)
    await rg(make_accessor(), [scope()], "needle", index=index)
    assert generic.await_args.args[2].get("H") is True


@pytest.mark.asyncio
async def test_dash_upper_i_suppression_survives_narrowing(harness, index):
    narrow, generic = harness
    narrow.return_value = ([spec("/data/a.txt")], True)
    await rg(make_accessor(), [scope()], "needle", args_I=True, index=index)
    assert "H" not in generic.await_args.args[2]


@pytest.mark.asyncio
async def test_walk_fallback_leaves_flags_alone(harness, index):
    narrow, generic = harness
    narrow.return_value = ([scope()], False)
    await rg(make_accessor(), [scope()], "needle", index=index)
    assert "H" not in generic.await_args.args[2]


@pytest.mark.asyncio
async def test_hidden_candidates_are_pruned(harness, index):
    narrow, generic = harness
    narrow.return_value = ([spec("/data/.env"), spec("/data/a.txt")], True)
    await rg(make_accessor(), [scope()], "needle", index=index)
    assert [p.virtual for p in generic.await_args.args[0]] == ["/data/a.txt"]


@pytest.mark.asyncio
async def test_all_hidden_narrowed_set_exits_one(harness, index):
    narrow, generic = harness
    narrow.return_value = ([spec("/data/.env")], True)
    stdout, io = await rg(make_accessor(), [scope()], "needle", index=index)
    assert stdout == b""
    assert io.exit_code == 1
    generic.assert_not_awaited()
