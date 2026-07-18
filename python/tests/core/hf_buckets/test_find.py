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

import pytest

from mirage.core.hf_buckets.find import find
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_find_root_returns_sorted_entries(make_acc):
    acc = make_acc({
        "a.json": b"a",
        "b.json": b"b",
        "data/c.json": b"c",
    })
    out = await find(acc, PathSpec.from_str_path("/"))
    assert out == ["/", "/a.json", "/b.json", "/data", "/data/c.json"]


@pytest.mark.asyncio
async def test_find_subdir_scopes_results(make_acc):
    acc = make_acc({
        "data/a.json": b"a",
        "data/sub/b.json": b"b",
        "other.txt": b"o",
    })
    out = await find(acc, PathSpec.from_str_path("/data"))
    assert out == ["/data", "/data/a.json", "/data/sub", "/data/sub/b.json"]


@pytest.mark.asyncio
async def test_find_missing_returns_empty(make_acc):
    acc = make_acc({})
    out = await find(acc, PathSpec.from_str_path("/nope"))
    assert out == []


@pytest.mark.asyncio
async def test_find_name_filter(make_acc):
    acc = make_acc({
        "a.json": b"a",
        "b.txt": b"b",
        "data/c.json": b"c",
    })
    out = await find(acc, PathSpec.from_str_path("/"), name="*.json")
    assert out == ["/a.json", "/data/c.json"]


@pytest.mark.asyncio
async def test_find_type_filter(make_acc):
    acc = make_acc({
        "a.json": b"a",
        "data/c.json": b"c",
    })
    files = await find(acc, PathSpec.from_str_path("/"), type="f")
    dirs = await find(acc, PathSpec.from_str_path("/"), type="d")
    assert files == ["/a.json", "/data/c.json"]
    assert dirs == ["/", "/data"]


@pytest.mark.asyncio
async def test_find_maxdepth(make_acc):
    acc = make_acc({
        "a.json": b"a",
        "data/c.json": b"c",
        "data/sub/d.json": b"d",
    })
    out = await find(acc, PathSpec.from_str_path("/"), maxdepth=1)
    assert out == ["/", "/a.json", "/data"]


@pytest.mark.asyncio
async def test_find_empty_matches_zero_length_file(make_acc):
    acc = make_acc({"empty.txt": b"", "full.txt": b"x"})
    out = await find(acc, PathSpec.from_str_path("/"), empty=True)
    assert out == ["/empty.txt"]
