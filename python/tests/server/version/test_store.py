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

from pathlib import Path

import pytest

from mirage.server.version.backend import LocalBackend
from mirage.server.version.errors import HeadMovedError
from mirage.server.version.store import VersionStore


@pytest.mark.asyncio
async def test_open_creates_bare_repo(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    assert store is not None
    assert (tmp_path / "ws" / "objects").is_dir()
    assert (tmp_path / "ws" / "HEAD").is_file()


@pytest.mark.asyncio
async def test_open_reuses_existing_repo(tmp_path: Path):
    backend = LocalBackend(tmp_path)
    await VersionStore.open(backend, "ws")
    reopened = await VersionStore.open(backend, "ws")
    assert reopened is not None


@pytest.mark.asyncio
async def test_blob_roundtrip(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    oid = await store.write_blob(b"hello")
    assert await store.read_blob(oid) == b"hello"


@pytest.mark.asyncio
async def test_identical_blobs_dedup(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    first = await store.write_blob(b"same-bytes")
    second = await store.write_blob(b"same-bytes")
    assert first == second


@pytest.mark.asyncio
async def test_tree_roundtrip(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    a = await store.write_blob(b"aaa")
    b = await store.write_blob(b"bbb")
    tree = await store.write_tree({"a.txt": a, "dir/b.txt": b})
    assert await store.read_tree(tree) == {"a.txt": a, "dir/b.txt": b}


@pytest.mark.asyncio
async def test_tree_nested_paths(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    x = await store.write_blob(b"x")
    y = await store.write_blob(b"y")
    z = await store.write_blob(b"z")
    tree = await store.write_tree({
        "top.txt": x,
        "d/one.txt": y,
        "d/sub/two.txt": z,
    })
    assert await store.read_tree(tree) == {
        "top.txt": x,
        "d/one.txt": y,
        "d/sub/two.txt": z,
    }


@pytest.mark.asyncio
async def test_commit_advances_branch(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    t1 = await store.write_tree({"a.txt": await store.write_blob(b"v1")})
    c1 = await store.commit(t1, parents=[], branch="main", message="first")
    assert await store.head("main") == c1

    t2 = await store.write_tree({"a.txt": await store.write_blob(b"v2")})
    c2 = await store.commit(t2, parents=[c1], branch="main", message="second")
    assert await store.head("main") == c2

    commit = await store.read_commit(c2)
    assert commit.parents == [c1]
    assert commit.message == b"second"


@pytest.mark.asyncio
async def test_commit_rejects_stale_head(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    c1 = await store.commit(await store.write_tree(
        {"a.txt": await store.write_blob(b"v1")}),
                            parents=[],
                            branch="main",
                            message="first")
    c2 = await store.commit(await store.write_tree(
        {"a.txt": await store.write_blob(b"v2")}),
                            parents=[c1],
                            branch="main",
                            message="second")
    assert await store.head("main") == c2

    with pytest.raises(HeadMovedError):
        await store.commit(await store.write_tree(
            {"a.txt": await store.write_blob(b"v3")}),
                           parents=[c1],
                           branch="main",
                           message="stale")
    assert await store.head("main") == c2


@pytest.mark.asyncio
async def test_branches_and_log(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    t1 = await store.write_tree({"a.txt": await store.write_blob(b"v1")})
    c1 = await store.commit(t1, parents=[], branch="main", message="first")
    t2 = await store.write_tree({"a.txt": await store.write_blob(b"v2")})
    c2 = await store.commit(t2, parents=[c1], branch="main", message="second")

    assert await store.branches() == ["main"]
    assert await store.log("main") == [c2, c1]


@pytest.mark.asyncio
async def test_tree_diff(tmp_path: Path):
    store = await VersionStore.open(LocalBackend(tmp_path), "ws")
    keep = await store.write_blob(b"keep")
    before = await store.write_blob(b"before")
    after = await store.write_blob(b"after")
    gone = await store.write_blob(b"gone")
    new = await store.write_blob(b"new")

    tree_a = await store.write_tree({
        "keep.txt": keep,
        "change.txt": before,
        "gone.txt": gone,
    })
    tree_b = await store.write_tree({
        "keep.txt": keep,
        "change.txt": after,
        "new.txt": new,
    })

    assert await store.diff(tree_a, tree_b) == {
        "added": ["new.txt"],
        "modified": ["change.txt"],
        "deleted": ["gone.txt"],
    }
