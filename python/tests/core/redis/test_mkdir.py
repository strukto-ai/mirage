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
from mirage.core.redis.mkdir import mkdir
from mirage.core.redis.mkdir_p import mkdir_p
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def mk_store():
    stores = []

    async def _make(prefix):
        s = RedisStore(url=REDIS_URL, key_prefix=prefix)
        await s.clear()
        await s.add_dir("/")
        stores.append(s)
        return RedisAccessor(s)

    yield _make
    for s in stores:
        await s.clear()
        await s.close()


@pytest.mark.asyncio
async def test_mkdir(mk_store):
    a = await mk_store("test:mkdir:1:")
    await mkdir(
        a,
        PathSpec(resource_path="newdir",
                 virtual="/newdir",
                 directory="/newdir"))
    assert await a.store.has_dir("/newdir")
    assert await a.store.get_modified("/newdir") is not None


@pytest.mark.asyncio
async def test_mkdir_parent_not_found(mk_store):
    a = await mk_store("test:mkdir:2:")
    # The operand is what a GNU stderr line names, so the error carries the
    # virtual path, not the internal "parent does not exist" phrasing.
    with pytest.raises(FileNotFoundError, match="/no/parent"):
        await mkdir(
            a,
            PathSpec(resource_path="no/parent",
                     virtual="/no/parent",
                     directory="/no/parent"))
    assert not await a.store.has_dir("/no/parent")


@pytest.mark.asyncio
async def test_mkdir_under_a_plain_file_is_not_a_directory(mk_store):
    a = await mk_store("test:mkdir:notdir:")
    await a.store.set_file("/plain", b"x")
    with pytest.raises(NotADirectoryError):
        await mkdir(
            a,
            PathSpec(resource_path="plain/sub",
                     virtual="/plain/sub",
                     directory="/plain/sub"))
    assert not await a.store.has_dir("/plain/sub")


@pytest.mark.asyncio
async def test_mkdir_deep_under_a_plain_file_is_not_a_directory(mk_store):
    a = await mk_store("test:mkdir:notdir2:")
    await a.store.set_file("/plain", b"x")
    with pytest.raises(NotADirectoryError):
        await mkdir(
            a,
            PathSpec(resource_path="plain/sub/deeper",
                     virtual="/plain/sub/deeper",
                     directory="/plain/sub/deeper"))


@pytest.mark.asyncio
async def test_mkdir_already_exists_needs_parents_to_be_idempotent(mk_store):
    a = await mk_store("test:mkdir:3:")
    spec = PathSpec(resource_path="dir", virtual="/dir", directory="/dir")
    await mkdir(a, spec)
    # Only -p is idempotent; plain mkdir refuses an existing target (GNU).
    with pytest.raises(FileExistsError):
        await mkdir(a, spec)
    await mkdir(a, spec, parents=True)
    assert await a.store.has_dir("/dir")


@pytest.mark.asyncio
async def test_mkdir_p_across_a_file_names_the_component(mk_store):
    a = await mk_store("test:mkdir:p1:")
    await a.store.set_file("/a.txt", b"hi")
    with pytest.raises(NotADirectoryError) as excinfo:
        await mkdir(a,
                    PathSpec(resource_path="a.txt/sub",
                             virtual="/a.txt/sub",
                             directory="/a.txt/sub"),
                    parents=True)
    # GNU quotes the component it tripped on, not the operand, and the file
    # it collided with is left alone.
    assert str(excinfo.value) == "/a.txt"
    assert not await a.store.has_dir("/a.txt")
    assert await a.store.get_file("/a.txt") == b"hi"


@pytest.mark.asyncio
async def test_mkdir_p_onto_a_file_target_is_eexist(mk_store):
    a = await mk_store("test:mkdir:p2:")
    await a.store.set_file("/a.txt", b"hi")
    with pytest.raises(FileExistsError, match="/a.txt"):
        await mkdir(a,
                    PathSpec(resource_path="a.txt",
                             virtual="/a.txt",
                             directory="/a.txt"),
                    parents=True)


@pytest.mark.asyncio
async def test_mkdir_refuses_an_existing_file(mk_store):
    a = await mk_store("test:mkdir:p3:")
    await a.store.set_file("/a.txt", b"hi")
    with pytest.raises(FileExistsError, match="/a.txt"):
        await mkdir(
            a,
            PathSpec(resource_path="a.txt",
                     virtual="/a.txt",
                     directory="/a.txt"))
    assert await a.store.get_file("/a.txt") == b"hi"


@pytest.mark.asyncio
async def test_mkdir_with_parents(mk_store):
    a = await mk_store("test:mkdir:4:")
    await mkdir(a,
                PathSpec(resource_path="a/b/c",
                         virtual="/a/b/c",
                         directory="/a/b/c"),
                parents=True)
    assert await a.store.has_dir("/a")
    assert await a.store.has_dir("/a/b")
    assert await a.store.has_dir("/a/b/c")


@pytest.mark.asyncio
async def test_mkdir_p(mk_store):
    a = await mk_store("test:mkdir:5:")
    await mkdir_p(a, PathSpec.from_str_path("/x/y/z"))
    assert await a.store.has_dir("/x")
    assert await a.store.has_dir("/x/y")
    assert await a.store.has_dir("/x/y/z")


@pytest.mark.asyncio
async def test_mkdir_p_existing_parent(mk_store):
    a = await mk_store("test:mkdir:6:")
    await a.store.add_dir("/existing")
    await mkdir_p(a, PathSpec.from_str_path("/existing/child/grandchild"))
    assert await a.store.has_dir("/existing/child")
    assert await a.store.has_dir("/existing/child/grandchild")


@pytest.mark.asyncio
async def test_mkdir_p_does_not_overwrite_modified(mk_store):
    a = await mk_store("test:mkdir:7:")
    await mkdir_p(a, PathSpec.from_str_path("/a"))
    original = await a.store.get_modified("/a")
    await mkdir_p(a, PathSpec.from_str_path("/a/b"))
    assert await a.store.get_modified("/a") == original
