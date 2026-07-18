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
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.ram.constants import SCOPE_ERROR
from mirage.core.ram.readdir import readdir
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec
from mirage.utils.glob_walk import make_resolve_glob

resolve_glob = make_resolve_glob(readdir, SCOPE_ERROR)


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.dirs.add("/src")
    s.files["/src/main.py"] = b"main"
    s.files["/src/util.py"] = b"util"
    s.files["/src/data.json"] = b"{}"
    s.files["/readme.md"] = b"readme"
    return a


@pytest.fixture
def accessor(store):
    return store


@pytest.fixture
def index():
    return RAMIndexCacheStore(ttl=600)


@pytest.mark.asyncio
async def test_resolve_glob_file_scope(accessor, index):
    scopes = [
        PathSpec(resource_path="readme.md",
                 virtual="/readme.md",
                 directory="/",
                 resolved=True)
    ]
    result = await resolve_glob(accessor, scopes, index)
    assert result[0].virtual == "/readme.md"


@pytest.mark.asyncio
async def test_resolve_glob_pattern(accessor, index):
    scopes = [
        PathSpec(
            resource_path="src/*.py",
            virtual="/src/*.py",
            directory="/src",
            pattern="*.py",
            resolved=False,
        )
    ]
    result = await resolve_glob(accessor, scopes, index)
    originals = [r.virtual for r in result]
    assert any(o == "/src/main.py" for o in originals)
    assert any(o == "/src/util.py" for o in originals)
    assert not any(o == "/src/data.json" for o in originals)


@pytest.mark.asyncio
async def test_resolve_glob_directory_scope(accessor, index):
    scopes = [
        PathSpec(resource_path="src",
                 virtual="/src",
                 directory="/src",
                 pattern=None,
                 resolved=False)
    ]
    result = await resolve_glob(accessor, scopes, index)
    assert result[0].virtual == "/src"


@pytest.mark.asyncio
async def test_resolve_glob_multiple_scopes(accessor, index):
    scopes = [
        PathSpec(resource_path="readme.md",
                 virtual="/readme.md",
                 directory="/",
                 resolved=True),
        PathSpec(
            resource_path="src/*.py",
            virtual="/src/*.py",
            directory="/src",
            pattern="*.py",
            resolved=False,
        ),
    ]
    result = await resolve_glob(accessor, scopes, index)
    assert result[0].virtual == "/readme.md"
    assert len(result) == 3
