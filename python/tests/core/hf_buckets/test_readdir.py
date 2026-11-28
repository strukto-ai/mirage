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

from mirage.core.hf_buckets.readdir import readdir as list_stats
from mirage.types import PathSpec
from tests.fixtures.hf_bucket import TREE


async def readdir(acc, path: PathSpec) -> list[str]:
    rows = await list_stats(acc, path)
    return [f"{path.virtual.rstrip('/')}/{row.name}" for row in rows]


@pytest.mark.asyncio
async def test_readdir_root_returns_children(make_acc):
    acc = await make_acc({"hello.txt": b"x", "data/file.txt": b"y"})
    entries = await readdir(acc, PathSpec.from_str_path("/"))
    assert "/data" in entries
    assert "/hello.txt" in entries


@pytest.mark.asyncio
async def test_readdir_subdir(make_acc):
    acc = await make_acc(
        {"data/a.txt": b"a", "data/sub/b.txt": b"b", "other.txt": b"o"}
    )
    entries = await readdir(acc, PathSpec.from_str_path("/data"))
    assert sorted(entries) == ["/data/a.txt", "/data/sub"]


@pytest.mark.asyncio
async def test_readdir_under_a_file_is_enotdir(make_acc):
    # A repo holds no directory objects, so the tree API answers a path it
    # does not have with an empty listing rather than an error; without a
    # check `ls /hf/a.txt/x` rendered an empty directory and exited 0.
    acc = await make_acc({"a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(acc, PathSpec.from_str_path("/a.txt/x"))


@pytest.mark.asyncio
async def test_readdir_answers_each_files_size(make_acc):
    acc = await make_acc({"f.txt": b"hello"})
    (row,) = await list_stats(acc, PathSpec.from_str_path("/"))
    assert (row.name, row.size) == ("f.txt", 5)


@pytest.mark.asyncio
async def test_readdir_root_of_an_empty_bucket_does_not_raise(make_acc):
    acc = await make_acc({})
    assert await readdir(acc, PathSpec.from_str_path("/")) == []


@pytest.mark.asyncio
async def test_readdir_missing_path_is_enoent(make_acc):
    acc = await make_acc({"data/a.txt": b"a"})
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/never_here"))


@pytest.mark.asyncio
async def test_readdir_missing_nested_path_is_enoent(make_acc):
    acc = await make_acc({"data/a.txt": b"a"})
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/data/nodir/deep"))


@pytest.mark.asyncio
async def test_readdir_on_a_file_is_enotdir(make_acc):
    acc = await make_acc({"data/a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(acc, PathSpec.from_str_path("/data/a.txt"))


@pytest.mark.asyncio
async def test_readdir_below_a_file_is_enotdir(make_acc):
    acc = await make_acc({"data/a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(acc, PathSpec.from_str_path("/data/a.txt/x"))


@pytest.mark.asyncio
async def test_readdir_directory_exists_only_while_it_holds_a_key(make_acc):
    # The hf service refuses a directory marker client-side, so unlike s3
    # there is no empty-directory trace to keep: removing the last key
    # removes the directory, which is what stat has always reported.
    acc = await make_acc({"data/a.txt": b"a"})
    assert await readdir(acc, PathSpec.from_str_path("/data")) == [
        "/data/a.txt"
    ]
    await acc.operator().delete("data/a.txt")
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/data"))


@pytest.mark.asyncio
async def test_readdir_lists_each_size_as_its_row_has_it(make_acc, bucket):
    # One tree request and no stat. The Hub sends a size for every file
    # (its own client requires one); a row without one, which it does not
    # send, reads as 0 through opendal, whose row size defaults to 0, so
    # the listing never holds a missing size to fill.
    acc = await make_acc({"data/a.txt": b"hello", "data/b.txt": b"abc"})
    await bucket.run.answer_next(
        "GET",
        TREE,
        200,
        [
            {"type": "file", "path": "data/a.txt", "size": 5},
            {"type": "file", "path": "data/b.txt"},
        ],
    )
    rows = await list_stats(acc, PathSpec.from_str_path("/data"))
    assert {row.name: row.size for row in rows} == {"a.txt": 5, "b.txt": 0}
    assert [name for name, _, _ in await bucket.log()] == ["tree"]


@pytest.mark.asyncio
async def test_readdir_under_a_key_prefix_lists_mount_relative(make_acc):
    acc = await make_acc(
        {
            "pfx/a.txt": b"a",
            "pfx/sub/b.txt": b"b",
            "a.txt": b"decoy",
        },
        key_prefix="pfx/",
    )
    entries = await readdir(acc, PathSpec.from_str_path("/"))
    assert sorted(entries) == ["/a.txt", "/sub"]
