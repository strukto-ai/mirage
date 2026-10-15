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
from mirage.core.redis.readdir import readdir, tree
from mirage.core.redis.stat import stat
from mirage.types import PathSpec
from mirage.vfs.redis.store import RedisStore

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor(redis_prefix):
    s = RedisStore(url=REDIS_URL, key_prefix=redis_prefix)
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/sub")
    await s.add_dir("/sub/deep")
    await s.set_file("/a.txt", b"a")
    await s.set_file("/b.txt", b"b")
    await s.set_file("/sub/c.txt", b"c")
    await s.set_file("/sub/d.txt", b"d")
    await s.set_file("/sub/deep/e.txt", b"e")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


async def _listed(accessor: RedisAccessor, spec: PathSpec) -> list[str]:
    rows = await readdir(accessor, spec)
    return [f"{spec.virtual.rstrip('/')}/{row.name}" for row in rows]


@pytest.mark.asyncio
async def test_readdir_root(accessor):
    entries = await _listed(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert "/a.txt" in entries
    assert "/b.txt" in entries
    assert "/sub" in entries
    assert len(entries) == 3
    rows = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert [row.type for row in rows] == ["file", "file", "directory"]


@pytest.mark.asyncio
async def test_readdir_subdir(accessor):
    entries = await _listed(
        accessor,
        PathSpec(vfs_path="sub", virtual="/sub", directory="/sub"),
    )
    assert "/sub/c.txt" in entries
    assert "/sub/d.txt" in entries
    assert "/sub/deep" in entries
    assert len(entries) == 3


@pytest.mark.asyncio
async def test_readdir_empty_dir(redis_prefix):
    s = RedisStore(url=REDIS_URL, key_prefix=f"{redis_prefix}e:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/empty")
    a = RedisAccessor(s)
    entries = await _listed(
        a,
        PathSpec(vfs_path="empty", virtual="/empty", directory="/empty"),
    )
    assert entries == []
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_readdir_not_found(redis_prefix):
    s = RedisStore(url=REDIS_URL, key_prefix=f"{redis_prefix}n:")
    await s.clear()
    await s.add_dir("/")
    a = RedisAccessor(s)
    with pytest.raises(FileNotFoundError):
        await _listed(
            a,
            PathSpec(
                vfs_path="nonexistent",
                virtual="/nonexistent",
                directory="/nonexistent",
            ),
        )
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_readdir_deep(accessor):
    entries = await _listed(
        accessor,
        PathSpec(
            vfs_path="sub/deep", virtual="/sub/deep", directory="/sub/deep"
        ),
    )
    assert "/sub/deep/e.txt" in entries
    assert len(entries) == 1


@pytest.mark.asyncio
async def test_readdir_file_component_is_not_a_directory(redis_prefix):
    # GNU `ls /a.txt/x` -> "Not a directory": a component exists but is a
    # file. Only a missing component is ENOENT.
    s = RedisStore(url=REDIS_URL, key_prefix=f"{redis_prefix}nd:")
    await s.clear()
    await s.add_dir("/")
    await s.set_file("/a.txt", b"a")
    a = RedisAccessor(s)
    for virtual in ("/a.txt", "/a.txt/x", "/a.txt/x/y"):
        with pytest.raises(NotADirectoryError):
            await _listed(
                a,
                PathSpec(
                    vfs_path=virtual.lstrip("/"),
                    virtual=virtual,
                    directory=virtual,
                ),
            )
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_readdir_missing_stays_not_found_at_any_depth(redis_prefix):
    s = RedisStore(url=REDIS_URL, key_prefix=f"{redis_prefix}nd2:")
    await s.clear()
    await s.add_dir("/")
    await s.set_file("/a.txt", b"a")
    a = RedisAccessor(s)
    with pytest.raises(FileNotFoundError):
        await _listed(
            a,
            PathSpec(
                vfs_path="nope/deeper",
                virtual="/nope/deeper",
                directory="/nope/deeper",
            ),
        )
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_readdir_orphan_below_a_missing_dir_is_not_found(redis_prefix):
    # The store can hold a file whose parent is not in the dir set: a
    # restored snapshot or another client on the same Redis can seed one, so
    # readdir stays defensive about it even though rename and copy now refuse
    # to create one. The walk must stop at /missing instead of reaching the
    # orphan and reporting ENOTDIR.
    s = RedisStore(url=REDIS_URL, key_prefix=f"{redis_prefix}orphan:")
    await s.clear()
    await s.add_dir("/")
    await s.set_file("/missing/a.txt", b"a")
    a = RedisAccessor(s)
    for virtual in ("/missing", "/missing/a.txt/x", "/missing/a.txt/x/y"):
        with pytest.raises(FileNotFoundError):
            await _listed(
                a,
                PathSpec(
                    vfs_path=virtual.lstrip("/"),
                    virtual=virtual,
                    directory=virtual,
                ),
            )
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_tree_answers_each_entry_as_stat_does(accessor):
    found = await tree(accessor, PathSpec.from_str_path("/sub"))
    assert found is not None
    assert sorted(found) == ["c.txt", "d.txt", "deep", "deep/e.txt"]
    for rel, st in found.items():
        assert st == await stat(
            accessor, PathSpec.from_str_path("/sub/" + rel)
        )


@pytest.mark.asyncio
async def test_tree_of_no_directory_is_none(accessor):
    assert await tree(accessor, PathSpec.from_str_path("/a.txt")) is None


@pytest.mark.asyncio
async def test_tree_declines_a_file_whose_folder_is_missing(accessor):
    await accessor.store.set_file("/missing/a.txt", b"x")
    assert await tree(accessor, PathSpec.from_str_path("/")) is None
