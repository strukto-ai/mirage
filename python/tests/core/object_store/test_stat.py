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

import asyncio
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
import pytest_asyncio

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.core.object_store.readdir import make_readdir, make_tree
from mirage.core.object_store.stat import make_stat
from mirage.types import FileType
from tests.core.object_store.conftest import (
    MODIFIED,
    FakeStore,
    make_driver,
    spec,
)


def test_stat_maps_the_driver_meta_onto_filestat(accessor):
    store = FakeStore({"a.txt": b"hi"})
    stat = make_stat(make_driver(store))
    st = asyncio.run(stat(accessor, spec("/a.txt")))
    assert st.size == 2
    assert st.modified == MODIFIED
    assert st.fingerprint == "fp-a.txt"
    assert st.revision == "rev-a.txt"
    assert st.extra == {"etag": "fp-a.txt"}


def test_stat_root_is_a_directory_without_connecting(accessor):
    store = FakeStore()
    stat = make_stat(make_driver(store))
    st = asyncio.run(stat(accessor, spec("/")))
    assert st.type == FileType.DIRECTORY
    assert store.connects == 0


def test_stat_prefix_is_a_directory(accessor):
    store = FakeStore({"dir/f.txt": b"x"})
    stat = make_stat(make_driver(store))
    assert asyncio.run(stat(accessor, spec("/dir"))).type == FileType.DIRECTORY


def test_stat_missing_is_enoent(accessor):
    stat = make_stat(make_driver(FakeStore({"a.txt": b"hi"})))
    with pytest.raises(FileNotFoundError):
        asyncio.run(stat(accessor, spec("/never")))


def test_stat_trailing_slash_prefers_the_coexisting_prefix(accessor):
    store = FakeStore({"csv": b"file", "csv/inner.txt": b"x"})
    stat = make_stat(make_driver(store))
    assert asyncio.run(stat(accessor, spec("/csv"))).type != (
        FileType.DIRECTORY
    )
    assert (
        asyncio.run(stat(accessor, spec("/csv/"))).type == FileType.DIRECTORY
    )


def test_stat_index_fast_path_skips_the_store(accessor):
    store = FakeStore({"a.txt": b"hi"})
    driver = make_driver(store)
    index = RAMIndexCacheStore()
    asyncio.run(make_readdir(driver)(accessor, spec("/"), index=index))
    connects = store.connects
    st = asyncio.run(make_stat(driver)(accessor, spec("/a.txt"), index=index))
    assert st.size == 2
    assert store.connects == connects


def test_stat_listed_parent_negative_caches_enoent(accessor):
    store = FakeStore({"a.txt": b"hi"})
    driver = make_driver(store)
    index = RAMIndexCacheStore()
    asyncio.run(make_readdir(driver)(accessor, spec("/"), index=index))
    connects = store.connects
    with pytest.raises(FileNotFoundError):
        asyncio.run(make_stat(driver)(accessor, spec("/.git"), index=index))
    assert store.connects == connects


def _size(found) -> int:
    return sum(st.size or 0 for st in (found or {}).values())


@pytest.mark.asyncio
@pytest.mark.parametrize("expiry", ["expired", "missing"])
@pytest.mark.parametrize("replacement", ["deleted", "file", "directory"])
async def test_recursive_metadata_requires_a_fresh_listing(
    accessor, expiry, replacement
):
    store = FakeStore({"data/old.txt": b"old"})
    driver = make_driver(store)
    index = RAMIndexCacheStore(ttl=60)
    path = spec("/data")
    stat = make_stat(driver)
    tree = make_tree(driver)
    with patch("mirage.cache.index.ram.datetime") as clock:
        clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
        await tree(accessor, path, index)
        store.connects = 0
        assert (await stat(accessor, path, index)).type == FileType.DIRECTORY
        assert store.connects == 0
        store.objects.clear()
        if replacement == "file":
            store.objects["data"] = b"new file"
        elif replacement == "directory":
            store.objects["data/new.txt"] = b"new contents"
        if expiry == "expired":
            clock.now.return_value += timedelta(seconds=61)
        else:
            await index.invalidate_dir(path.virtual)
        if replacement == "deleted":
            with pytest.raises(FileNotFoundError):
                await stat(accessor, path, index)
            assert await tree(accessor, path, index) is None
        else:
            current = await stat(accessor, path, index)
            assert current.type == (
                FileType.FILE if replacement == "file" else FileType.DIRECTORY
            )
        with pytest.raises(FileNotFoundError):
            await stat(accessor, spec("/data/old.txt"), index)
        found = await tree(accessor, path, index)
        if replacement == "directory":
            assert _size(found) == len(b"new contents")


@pytest.mark.asyncio
@pytest.mark.parametrize("refresh", ["tree", "readdir"])
async def test_refresh_does_not_revive_an_expired_folder(accessor, refresh):
    store = FakeStore({"data/old.txt": b"old"})
    driver = make_driver(store)
    index = RAMIndexCacheStore(ttl=60)
    path = spec("/data")
    tree = make_tree(driver)
    with patch("mirage.cache.index.ram.datetime") as clock:
        clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
        await tree(accessor, path, index)
        store.objects.clear()
        store.objects.update({"data": b"file", "data/new.txt": b"new"})
        clock.now.return_value += timedelta(seconds=61)
        if refresh == "tree":
            await tree(accessor, path, index)
        else:
            await make_readdir(driver)(accessor, path, index)
        assert (
            await make_stat(driver)(accessor, path, index)
        ).type == FileType.FILE


@pytest_asyncio.fixture(params=["ram", "redis"])
async def index_store(request):
    if request.param == "redis":
        url = os.environ.get("REDIS_URL")
        if not url:
            pytest.skip("REDIS_URL not set")
        index = RedisIndexCacheStore(url=url, key_prefix=f"stat:{uuid4()}:")
    else:
        index = RAMIndexCacheStore()
    try:
        yield index
    finally:
        await index.clear()
        await index.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path,kind", [("/a.txt", FileType.FILE), ("/dir", FileType.DIRECTORY)]
)
async def test_stat_listed_child_without_metadata(
    accessor, index_store, path, kind
):
    store = FakeStore({"a.txt": b"hi", "dir/f.txt": b"x"})
    driver = make_driver(store)
    await make_readdir(driver)(accessor, spec("/"), index=index_store)
    # Drop only this child's metadata, leaving fresh membership intact.
    await index_store.invalidate_prefix("/mnt" + path)
    assert (await index_store.get("/mnt" + path)).entry is None
    assert "/mnt" + path in (await index_store.list_dir("/mnt")).entries
    connects = store.connects
    st = await make_stat(driver)(accessor, spec(path), index=index_store)
    assert st.type == kind
    assert store.connects > connects
    if kind == FileType.FILE:
        assert st.size == 2
        assert st.fingerprint == "fp-a.txt"
    connects = store.connects
    with pytest.raises(FileNotFoundError):
        await make_stat(driver)(accessor, spec("/.git"), index=index_store)
    assert store.connects == connects


@pytest.mark.asyncio
async def test_stat_stale_membership_cannot_prove_absence(
    accessor, index_store
):
    store = FakeStore({"a.txt": b"hi"})
    driver = make_driver(store)
    await make_readdir(driver)(accessor, spec("/"), index=index_store)
    await index_store.invalidate()
    store.objects["new.txt"] = b"new"
    st = await make_stat(driver)(accessor, spec("/new.txt"), index=index_store)
    assert st.size == 3
