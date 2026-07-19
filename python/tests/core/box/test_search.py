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

from mirage.accessor.box import BoxAccessor
from mirage.core.box._client import BoxApiError, BoxTokenManager
from mirage.core.box.config import BoxConfig
from mirage.core.box.search import narrow_paths
from mirage.types import PathSpec


def make_accessor(root_folder_id: str | None = None) -> BoxAccessor:
    config = BoxConfig(access_token="tok",
                       root_folder_id=root_folder_id,
                       content_search=True)
    return BoxAccessor(config, BoxTokenManager(config))


def mount_root() -> PathSpec:
    return PathSpec(resource_path="", virtual="/data", directory="/data")


def _file(item_id: str, name: str, chain: list[tuple[str, str]]) -> dict:
    return {
        "id": item_id,
        "name": name,
        "type": "file",
        "path_collection": {
            "total_count":
            len(chain),
            "entries": [{
                "type": "folder",
                "id": cid,
                "name": cname
            } for cid, cname in chain],
        },
    }


ROOT = [("0", "All Files")]


@pytest.mark.asyncio
async def test_narrow_maps_path_collection_to_mount_paths():
    results = [
        _file("2", "x.txt", ROOT),
        _file("3", "y.txt", ROOT + [("100", "Sub")]),
    ]
    with patch("mirage.core.box.search.search_content",
               new_callable=AsyncMock,
               return_value=(results, False)) as spy:
        out = await narrow_paths(make_accessor(), "needle", [mount_root()])
    assert spy.await_args.args[2] == "0"
    assert out is not None
    assert [p.virtual for p in out] == ["/data/Sub/y.txt", "/data/x.txt"]
    assert out[1].resource_path == "x.txt"
    assert out[1].resolved


@pytest.mark.asyncio
async def test_narrow_sorts_results_in_walk_order():
    # A sorted readdir walk descends into foo/ before visiting foo.txt;
    # plain lexicographic path order would put foo.txt first ('.' < '/').
    results = [
        _file("2", "foo.txt", ROOT),
        _file("3", "inner.txt", ROOT + [("100", "foo")]),
    ]
    with patch("mirage.core.box.search.search_content",
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
    with patch("mirage.core.box.search.search_content",
               new_callable=AsyncMock,
               return_value=([_file("2", "x.txt", ROOT)], False)):
        out = await narrow_paths(make_accessor(), "needle", [scope])
    assert out is not None
    assert out[0].raw_path == "./x.txt"


@pytest.mark.asyncio
async def test_narrow_subfolder_scope_resolves_id_and_trims_key():
    scope = PathSpec(resource_path="docs",
                     virtual="/data/docs",
                     directory="/data/docs")
    results = [_file("5", "in.txt", ROOT + [("100", "docs")])]
    with patch("mirage.core.box.search.resolve_item",
               new_callable=AsyncMock,
               return_value={"id": "100", "type": "folder"}), \
         patch("mirage.core.box.search.search_content",
               new_callable=AsyncMock,
               return_value=(results, False)) as spy:
        out = await narrow_paths(make_accessor(), "needle", [scope])
    assert spy.await_args.args[2] == "100"
    assert out is not None
    assert [p.virtual for p in out] == ["/data/docs/in.txt"]


@pytest.mark.asyncio
async def test_narrow_non_folder_scope_returns_none():
    scope = PathSpec(resource_path="a.txt",
                     virtual="/data/a.txt",
                     directory="/data/a.txt")
    with patch("mirage.core.box.search.resolve_item",
               new_callable=AsyncMock,
               return_value={
                   "id": "9",
                   "type": "file"
               }):
        out = await narrow_paths(make_accessor(), "needle", [scope])
    assert out is None


@pytest.mark.asyncio
async def test_narrow_api_error_returns_none():
    with patch("mirage.core.box.search.search_content",
               new_callable=AsyncMock,
               side_effect=BoxApiError("boom", 500)):
        out = await narrow_paths(make_accessor(), "needle", [mount_root()])
    assert out is None


@pytest.mark.asyncio
async def test_narrow_truncated_results_return_none():
    with patch("mirage.core.box.search.search_content",
               new_callable=AsyncMock,
               return_value=([_file("2", "x.txt", ROOT)], True)):
        out = await narrow_paths(make_accessor(), "needle", [mount_root()])
    assert out is None
