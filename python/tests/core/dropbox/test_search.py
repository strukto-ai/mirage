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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox._client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.search import narrow_paths
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import PathSpec


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


def mount_root() -> PathSpec:
    return PathSpec(resource_path="", virtual="/data", directory="/data")


def subdir() -> PathSpec:
    return PathSpec(resource_path="docs",
                    virtual="/data/docs",
                    directory="/data/docs")


@pytest.mark.asyncio
async def test_narrow_maps_api_paths_to_mount_paths():
    results = [("/x.txt", "/x.txt"), ("/sub/y.txt", "/Sub/Y.txt")]
    with patch("mirage.core.dropbox.search.search_files",
               new_callable=AsyncMock,
               return_value=(results, False)) as spy:
        out = await narrow_paths(make_accessor(), "needle", [mount_root()])
    assert spy.await_args.kwargs["path"] == ""
    assert out is not None
    assert [p.virtual for p in out] == ["/data/Sub/Y.txt", "/data/x.txt"]
    assert out[1].resource_path == "x.txt"
    assert out[1].resolved


@pytest.mark.asyncio
async def test_narrow_strips_root_path_case_insensitively():
    results = [("/team/sub/a.txt", "/Team/Sub/A.txt")]
    with patch("mirage.core.dropbox.search.search_files",
               new_callable=AsyncMock,
               return_value=(results, False)) as spy:
        out = await narrow_paths(make_accessor("/Team"), "needle",
                                 [mount_root()])
    assert spy.await_args.kwargs["path"] == "/Team"
    assert out is not None
    assert [p.virtual for p in out] == ["/data/Sub/A.txt"]


@pytest.mark.asyncio
async def test_narrow_filters_results_outside_the_scope():
    results = [("/docs/in.txt", "/docs/in.txt"),
               ("/other/out.txt", "/other/out.txt")]
    with patch("mirage.core.dropbox.search.search_files",
               new_callable=AsyncMock,
               return_value=(results, False)) as spy:
        out = await narrow_paths(make_accessor(), "needle", [subdir()])
    assert spy.await_args.kwargs["path"] == "/docs"
    assert out is not None
    assert [p.virtual for p in out] == ["/data/docs/in.txt"]


@pytest.mark.asyncio
async def test_narrow_sorts_results_in_walk_order():
    # A sorted readdir walk descends into foo/ before visiting foo.txt;
    # plain lexicographic path order would put foo.txt first ('.' < '/').
    results = [("/foo.txt", "/foo.txt"), ("/foo/inner.txt", "/foo/inner.txt")]
    with patch("mirage.core.dropbox.search.search_files",
               new_callable=AsyncMock,
               return_value=(results, False)):
        out = await narrow_paths(make_accessor(), "needle", [mount_root()])
    assert out is not None
    assert [p.virtual for p in out] == ["/data/foo/inner.txt", "/data/foo.txt"]


@pytest.mark.asyncio
async def test_narrow_rebases_raw_onto_the_scope_spelling():
    scope = PathSpec(resource_path="",
                     virtual="/data",
                     directory="/data",
                     raw_path=".")
    results = [("/x.txt", "/x.txt")]
    with patch("mirage.core.dropbox.search.search_files",
               new_callable=AsyncMock,
               return_value=(results, False)):
        out = await narrow_paths(make_accessor(), "needle", [scope])
    assert out is not None
    assert out[0].raw_path == "./x.txt"


@pytest.mark.asyncio
async def test_narrow_api_error_returns_none():
    with patch("mirage.core.dropbox.search.search_files",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("boom", 500)):
        out = await narrow_paths(make_accessor(), "needle", [mount_root()])
    assert out is None


@pytest.mark.asyncio
async def test_narrow_truncated_results_return_none():
    results = [("/x.txt", "/x.txt")]
    with patch("mirage.core.dropbox.search.search_files",
               new_callable=AsyncMock,
               return_value=(results, True)):
        out = await narrow_paths(make_accessor(), "needle", [mount_root()])
    assert out is None
