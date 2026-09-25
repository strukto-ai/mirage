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

from functools import partial

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.hf_buckets.readdir import readdir
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_readdir_root_returns_children(make_acc):
    acc = make_acc({"hello.txt": b"x", "data/file.txt": b"y"})
    entries = await readdir(acc, PathSpec.from_str_path("/"),
                            RAMIndexCacheStore(ttl=60))
    assert "/data" in entries
    assert "/hello.txt" in entries


@pytest.mark.asyncio
async def test_readdir_subdir(make_acc):
    acc = make_acc({
        "data/a.txt": b"a",
        "data/sub/b.txt": b"b",
        "other.txt": b"o"
    })
    entries = await readdir(acc, PathSpec.from_str_path("/data"),
                            RAMIndexCacheStore(ttl=60))
    assert sorted(entries) == ["/data/a.txt", "/data/sub"]


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir(make_acc):
    # A repo holds no directory objects, so the tree API answers a path it
    # does not have with an empty listing rather than an error; without a
    # check `ls /hf/a.txt/x` rendered an empty directory and exited 0.
    acc = make_acc({"a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(acc, PathSpec.from_str_path("/a.txt/x"),
                      RAMIndexCacheStore(ttl=60))


@pytest.mark.asyncio
async def test_readdir_populates_index_cache(make_acc):
    acc = make_acc({"f.txt": b"hello"})
    cache = RAMIndexCacheStore(ttl=60)
    await readdir(acc, PathSpec.from_str_path("/"), cache)
    lookup = await cache.get("/f.txt")
    assert lookup.entry is not None
    assert lookup.entry.size == 5
    assert lookup.entry.resource_type == "file"


async def _null_meta_iter(entries, null_key: str):
    async for entry in entries:
        if entry.path == null_key:
            entry.metadata = None
        yield entry


async def _stripped_list(inner, null_key: str, path, **kw):
    return _null_meta_iter(await inner(path, **kw), null_key)


@pytest.mark.asyncio
async def test_readdir_root_of_an_empty_bucket_does_not_raise(make_acc):
    acc = make_acc({})
    assert await readdir(acc, PathSpec.from_str_path("/"),
                         RAMIndexCacheStore(ttl=60)) == []


@pytest.mark.asyncio
async def test_readdir_missing_path_is_enoent(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/never_here"),
                      RAMIndexCacheStore(ttl=60))


@pytest.mark.asyncio
async def test_readdir_missing_nested_path_is_enoent(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/data/nodir/deep"),
                      RAMIndexCacheStore(ttl=60))


@pytest.mark.asyncio
async def test_readdir_on_a_file_is_enotdir(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(acc, PathSpec.from_str_path("/data/a.txt"),
                      RAMIndexCacheStore(ttl=60))


@pytest.mark.asyncio
async def test_readdir_below_a_file_is_enotdir(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(acc, PathSpec.from_str_path("/data/a.txt/x"),
                      RAMIndexCacheStore(ttl=60))


@pytest.mark.asyncio
async def test_readdir_directory_exists_only_while_it_holds_a_key(make_acc):
    # The hf service refuses a directory marker client-side, so unlike s3
    # there is no empty-directory trace to keep: removing the last key
    # removes the directory, which is what stat has always reported.
    acc = make_acc({"data/a.txt": b"a"})
    assert await readdir(acc, PathSpec.from_str_path("/data"),
                         RAMIndexCacheStore(ttl=60)) == ["/data/a.txt"]
    await acc.operator().delete("data/a.txt")
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/data"),
                      RAMIndexCacheStore(ttl=60))


@pytest.mark.asyncio
async def test_readdir_backfills_lister_omitted_size(make_acc):
    # When the lister omits metadata, readdir does one stat per affected
    # file instead of caching an unknown size.
    acc = make_acc({"a.txt": b"hello", "b.txt": b"abc"})
    fake = acc._fake
    fake.list = partial(_stripped_list, fake.list, "a.txt")
    cache = RAMIndexCacheStore(ttl=60)
    await readdir(acc, PathSpec.from_str_path("/"), cache)
    entry = (await cache.get("/a.txt")).entry
    assert entry is not None
    assert entry.size == 5


@pytest.mark.asyncio
async def test_readdir_under_a_key_prefix_lists_mount_relative(make_acc):
    acc = make_acc(
        {
            "pfx/a.txt": b"a",
            "pfx/sub/b.txt": b"b",
            "a.txt": b"decoy",
        },
        key_prefix="pfx/")
    entries = await readdir(acc, PathSpec.from_str_path("/"),
                            RAMIndexCacheStore(ttl=60))
    assert sorted(entries) == ["/a.txt", "/sub"]
