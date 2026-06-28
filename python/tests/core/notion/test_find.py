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

from mirage.core.notion import find as find_mod
from mirage.types import FileStat, FileType, PathSpec

_DIRS = {"/db", "/db/sub"}
_FILES = {
    "/db/page1.md": 10,
    "/db/sub/page2.md": 20,
}
_CHILDREN = {
    "/db": ["/db/page1.md", "/db/sub"],
    "/db/sub": ["/db/sub/page2.md"],
}


async def _fake_readdir(accessor, path, index):
    key = path.original if isinstance(path, PathSpec) else path
    key = "/" + key.strip("/") if key.strip("/") else "/"
    return _CHILDREN.get(key, [])


async def _fake_stat(accessor, path, index=None):
    key = path.original if isinstance(path, PathSpec) else path
    key = "/" + key.strip("/") if key.strip("/") else "/"
    if key in _DIRS:
        return FileStat(name=key.rsplit("/", 1)[-1] or "/",
                        type=FileType.DIRECTORY)
    return FileStat(name=key.rsplit("/", 1)[-1],
                    type=FileType.TEXT,
                    size=_FILES.get(key))


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    monkeypatch.setattr(find_mod, "readdir", _fake_readdir)
    monkeypatch.setattr(find_mod, "stat", _fake_stat)


@pytest.mark.asyncio
async def test_find_all():
    out = await find_mod.find(None, PathSpec.from_str_path("/db"))
    assert out == ["/db", "/db/page1.md", "/db/sub", "/db/sub/page2.md"]


@pytest.mark.asyncio
async def test_find_name_matches_mount_root_start_path():
    spec = PathSpec(original="/db", directory="/db", prefix="/db")
    out = await find_mod.find(None, spec, name="db")
    assert out == ["/"]


@pytest.mark.asyncio
async def test_find_type_file():
    out = await find_mod.find(None, PathSpec.from_str_path("/db"), type="f")
    assert out == ["/db/page1.md", "/db/sub/page2.md"]


@pytest.mark.asyncio
async def test_find_type_dir():
    out = await find_mod.find(None, PathSpec.from_str_path("/db"), type="d")
    assert out == ["/db", "/db/sub"]


@pytest.mark.asyncio
async def test_find_name_glob():
    out = await find_mod.find(None, PathSpec.from_str_path("/db"), name="*.md")
    assert out == ["/db/page1.md", "/db/sub/page2.md"]


@pytest.mark.asyncio
async def test_find_maxdepth():
    out = await find_mod.find(None, PathSpec.from_str_path("/db"), maxdepth=1)
    assert out == ["/db", "/db/page1.md", "/db/sub"]


@pytest.mark.asyncio
async def test_find_mindepth():
    out = await find_mod.find(None, PathSpec.from_str_path("/db"), mindepth=1)
    assert out == ["/db/page1.md", "/db/sub", "/db/sub/page2.md"]


@pytest.mark.asyncio
async def test_find_min_size():
    out = await find_mod.find(None,
                              PathSpec.from_str_path("/db"),
                              type="f",
                              min_size=15)
    assert out == ["/db/sub/page2.md"]
