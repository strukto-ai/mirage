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

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.find import find
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.dirs.add("/src")
    s.dirs.add("/src/lib")
    s.files["/readme.md"] = b"readme"
    s.files["/src/main.py"] = b"print('hi')"
    s.files["/src/util.py"] = b"def f(): pass"
    s.files["/src/lib/helper.py"] = b"helper"
    s.files["/src/lib/data.json"] = b"{}"
    s.files["/big.bin"] = b"x" * 1000
    return a


@pytest.mark.asyncio
async def test_find_all(store):
    results = await find(
        store,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"))
    assert "/readme.md" in results
    assert "/src/main.py" in results
    assert "/src/lib/helper.py" in results
    assert "/src/lib/data.json" in results
    assert "/big.bin" in results


@pytest.mark.asyncio
async def test_find_by_name(store):
    results = await find(store,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         name="*.py")
    assert results == ["/src/lib/helper.py", "/src/main.py", "/src/util.py"]


@pytest.mark.asyncio
async def test_find_name_matches_mount_root_start_path(store):
    results = await find(store,
                         PathSpec(resource_path="",
                                  virtual="/data",
                                  directory="/data"),
                         name="data")
    assert results == ["/"]


@pytest.mark.asyncio
async def test_find_by_type_file(store):
    results = await find(store,
                         PathSpec(resource_path=("/src").strip("/"),
                                  virtual="/src",
                                  directory="/src"),
                         type="f")
    assert "/src/main.py" in results
    assert "/src/lib" not in results


@pytest.mark.asyncio
async def test_find_by_type_dir(store):
    results = await find(store,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         type="d")
    assert "/src" in results
    assert "/src/lib" in results
    assert "/readme.md" not in results


@pytest.mark.asyncio
async def test_find_maxdepth(store):
    results = await find(store,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         maxdepth=1,
                         type="f")
    assert "/readme.md" in results
    assert "/big.bin" in results
    assert "/src/main.py" not in results
    assert "/src/lib/helper.py" not in results


@pytest.mark.asyncio
async def test_find_mindepth(store):
    results = await find(store,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         mindepth=2,
                         type="f")
    assert "/readme.md" not in results
    assert "/src/main.py" in results
    assert "/src/lib/helper.py" in results


@pytest.mark.asyncio
async def test_find_min_size(store):
    results = await find(store,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         min_size=100,
                         type="f")
    assert results == ["/big.bin"]


@pytest.mark.asyncio
async def test_find_max_size(store):
    results = await find(store,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         max_size=10,
                         type="f")
    assert "/readme.md" in results
    assert "/src/lib/data.json" in results
    assert "/big.bin" not in results


@pytest.mark.asyncio
async def test_find_name_exclude(store):
    results = await find(store,
                         PathSpec(resource_path=("/src").strip("/"),
                                  virtual="/src",
                                  directory="/src"),
                         name="*.py",
                         name_exclude="util*")
    assert "/src/util.py" not in results
    assert "/src/main.py" in results


@pytest.mark.asyncio
async def test_find_or_names(store):
    results = await find(store,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         or_names=["*.py", "*.json"])
    assert "/src/main.py" in results
    assert "/src/lib/data.json" in results
    assert "/readme.md" not in results


@pytest.mark.asyncio
async def test_find_iname(store):
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/File.TXT"] = b"data"
    s.files["/other.txt"] = b"data"
    results = await find(a,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         iname="*.txt")
    assert "/File.TXT" in results
    assert "/other.txt" in results


@pytest.mark.asyncio
async def test_find_path_pattern(store):
    results = await find(store,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         path_pattern="/src/lib/*")
    assert "/src/lib/helper.py" in results
    assert "/src/lib/data.json" in results
    assert "/src/main.py" not in results


@pytest.mark.asyncio
async def test_find_subdir(store):
    results = await find(store,
                         PathSpec(resource_path=("/src/lib").strip("/"),
                                  virtual="/src/lib",
                                  directory="/src/lib"),
                         type="f")
    assert results == ["/src/lib/data.json", "/src/lib/helper.py"]


@pytest.mark.asyncio
async def test_find_empty_result():
    s = RAMStore()

    a = RAMAccessor(s)
    results = await find(a,
                         PathSpec(resource_path=("/").strip("/"),
                                  virtual="/",
                                  directory="/"),
                         name="*.xyz")
    assert results == []
