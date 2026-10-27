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
import errno
from dataclasses import replace

import pytest

from mirage.core.object_store.driver import TreeEntry
from mirage.core.object_store.readdir import make_readdir, make_tree
from mirage.types import DirListing, FileType
from tests.core.object_store.conftest import FakeStore, make_driver, spec


def test_readdir_lists_files_and_collapsed_dirs(accessor):
    store = FakeStore({"a.txt": b"hi", "dir/f.txt": b"x", "dir/sub/g": b"y"})
    readdir = make_readdir(make_driver(store))
    out = asyncio.run(readdir(accessor, spec("/")))
    assert [(row.name, row.type, row.size) for row in out] == [
        ("a.txt", FileType.FILE, 2),
        ("dir", FileType.DIRECTORY, None),
    ]


def test_readdir_lists_a_name_that_is_a_key_and_a_prefix_as_a_directory(
    accessor,
):
    store = FakeStore({"csv": b"file", "csv/inner.txt": b"x"})
    out = asyncio.run(make_readdir(make_driver(store))(accessor, spec("/")))
    assert [(row.name, row.type) for row in out] == [
        ("csv", FileType.DIRECTORY)
    ]


def test_readdir_marker_only_directory_is_empty_not_missing(accessor):
    store = FakeStore({"empty/": b""})
    readdir = make_readdir(make_driver(store))
    assert asyncio.run(readdir(accessor, spec("/empty"))) == []


def test_readdir_missing_path_is_enoent(accessor):
    store = FakeStore({"a.txt": b"hi"})
    readdir = make_readdir(make_driver(store))
    with pytest.raises(FileNotFoundError):
        asyncio.run(readdir(accessor, spec("/never")))


def test_readdir_on_a_file_is_enotdir(accessor):
    store = FakeStore({"a.txt": b"hi"})
    readdir = make_readdir(make_driver(store))
    with pytest.raises(NotADirectoryError):
        asyncio.run(readdir(accessor, spec("/a.txt")))


@pytest.mark.parametrize(
    "refused, path",
    [({"rd/b.txt"}, "/rd/b.txt/x"), ({"rd/"}, "/rd/x")],
    ids=["file-above", "prefix-above"],
)
def test_readdir_names_a_refused_probe_as_typed(accessor, refused, path):
    # The store's own error names the key, which carries the mount's prefix.
    store = FakeStore({"rd/b.txt": b"x"})
    store.refused.update(refused)
    readdir = make_readdir(make_driver(store))
    with pytest.raises(PermissionError) as caught:
        asyncio.run(readdir(accessor, spec(path)))
    assert caught.value.errno == errno.EACCES
    assert caught.value.filename == "/mnt" + path


def test_readdir_root_of_an_empty_store_does_not_raise(accessor):
    readdir = make_readdir(make_driver(FakeStore()))
    assert asyncio.run(readdir(accessor, spec("/"))) == []


def test_tree_answers_each_entry_and_implied_directory(accessor):
    store = FakeStore({"a.txt": b"hi", "dir/sub/f.txt": b"x", "/": b""})
    found = asyncio.run(make_tree(make_driver(store))(accessor, spec("/")))
    assert found is not None
    assert sorted(found) == ["", "a.txt", "dir", "dir/sub", "dir/sub/f.txt"]
    assert found[""].type == FileType.DIRECTORY
    assert found["dir/sub/f.txt"].size == 1
    assert found["dir"].type == FileType.DIRECTORY


@pytest.mark.parametrize(
    "objects",
    [
        {"dir/a": b"f", "dir/a/b.txt": b"x"},
        {"dir/a//b.txt": b"x"},
    ],
    ids=["file-and-prefix", "empty-segment"],
)
def test_tree_declines_what_readdir_lists_its_own_way(accessor, objects):
    tree = make_tree(make_driver(FakeStore(objects)))
    assert asyncio.run(tree(accessor, spec("/dir"))) is None


def test_tree_declines_a_row_without_a_size(accessor):
    async def list_subtree(conn, stem):
        yield TreeEntry(key="dir/a.txt", size=None)

    driver = replace(
        make_driver(FakeStore({"dir/a.txt": b"x"})), list_subtree=list_subtree
    )
    assert asyncio.run(make_tree(driver)(accessor, spec("/dir"))) is None


def test_readdir_stops_at_a_walks_limit_and_marks_the_listing_partial(
    accessor,
):
    store = FakeStore({f"f{i}.txt": b"x" for i in range(5)})
    pulled: list[str] = []
    driver = make_driver(store)

    async def counted(conn, pfx):
        async for child in driver.list_children(conn, pfx):
            pulled.append(child.key)
            yield child

    readdir = make_readdir(replace(driver, list_children=counted))
    out = asyncio.run(readdir(accessor, spec("/"), 2))
    assert isinstance(out, DirListing) and out.partial
    assert [row.name for row in out.entries] == ["f0.txt", "f1.txt"]
    assert pulled == ["f0.txt", "f1.txt", "f2.txt"]
    assert len(asyncio.run(readdir(accessor, spec("/"), 5))) == 5


def test_a_walks_limit_counts_a_name_both_key_and_prefix_once(accessor):
    keys = ("a", "a/x", "b", "b/x", "c", "d")
    store = FakeStore({k: b"x" for k in keys})
    out = asyncio.run(make_readdir(make_driver(store))(accessor, spec("/"), 3))
    assert [row.name for row in out.entries] == ["a", "b", "c"]


def test_a_cut_listing_stops_at_a_kept_directorys_next_row(accessor):
    store = FakeStore(
        {k: b"x" for k in ["a", "c"] + [f"b/{i}" for i in range(9)]}
    )
    pulled: list[str] = []
    driver = make_driver(store)

    async def counted(conn, pfx):
        async for child in driver.list_children(conn, pfx):
            pulled.append(child.key)
            yield child

    readdir = make_readdir(replace(driver, list_children=counted))
    out = asyncio.run(readdir(accessor, spec("/"), 2))
    assert [row.name for row in out.entries] == ["a", "b"]
    assert pulled == ["a", "b", "b"]


def test_a_listing_that_skips_a_name_past_its_limit_is_partial(accessor):
    store = FakeStore({k: b"x" for k in ("a", "b", "b.conf")})
    out = asyncio.run(make_readdir(make_driver(store))(accessor, spec("/"), 2))
    assert isinstance(out, DirListing) and out.partial
    assert [row.name for row in out.entries] == ["a", "b"]


def test_a_cut_listing_reads_on_until_a_kept_file_proves_a_directory(
    accessor,
):
    store = FakeStore({k: b"x" for k in ("a", "b", "b/x", "c")})
    out = asyncio.run(make_readdir(make_driver(store))(accessor, spec("/"), 2))
    assert isinstance(out, DirListing) and out.partial
    assert [(row.name, row.type) for row in out.entries] == [
        ("a", FileType.FILE),
        ("b", FileType.DIRECTORY),
    ]


def test_tree_answers_none_past_a_walks_limit(accessor):
    store = FakeStore({f"dir/f{i}.txt": b"x" for i in range(5)})
    tree = make_tree(make_driver(store))
    assert asyncio.run(tree(accessor, spec("/dir"), 3)) is None
    assert len(asyncio.run(tree(accessor, spec("/dir"), 5))) == 6
