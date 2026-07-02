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

import os

import pytest
import pytest_asyncio

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.redis.glob import resolve_glob
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:glob:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/src")
    await s.set_file("/src/main.py", b"main")
    await s.set_file("/src/util.py", b"util")
    await s.set_file("/src/data.json", b"{}")
    await s.set_file("/readme.md", b"readme")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.fixture
def index():
    return RAMIndexCacheStore(ttl=600)


@pytest.mark.asyncio
async def test_resolve_glob_file_scope(accessor, index):
    scopes = [
        PathSpec(resource_path=("/readme.md").strip("/"),
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
            resource_path=("/src/*.py").strip("/"),
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
        PathSpec(
            resource_path=("/src").strip("/"),
            virtual="/src",
            directory="/src",
            pattern=None,
            resolved=False,
        )
    ]
    result = await resolve_glob(accessor, scopes, index)
    assert result[0].virtual == "/src"


@pytest.mark.asyncio
async def test_resolve_glob_multiple_scopes(accessor, index):
    scopes = [
        PathSpec(resource_path=("/readme.md").strip("/"),
                 virtual="/readme.md",
                 directory="/",
                 resolved=True),
        PathSpec(
            resource_path=("/src/*.py").strip("/"),
            virtual="/src/*.py",
            directory="/src",
            pattern="*.py",
            resolved=False,
        ),
    ]
    result = await resolve_glob(accessor, scopes, index)
    assert result[0].virtual == "/readme.md"
    assert len(result) == 3
