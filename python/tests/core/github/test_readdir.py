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

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from fakeredis.aioredis import FakeRedis

import mirage.core.github.tree
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.core.github.read import read
from mirage.core.github.readdir import readdir
from mirage.core.github.stat import stat
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import FileType, PathSpec


def _index_from_tree(tree: dict[str, TreeEntry]) -> RAMIndexCacheStore:
    index = RAMIndexCacheStore()
    dirs: dict[str, list[tuple[str, IndexEntry]]] = defaultdict(list)
    for path, entry in tree.items():
        parts = path.rsplit("/", 1)
        if len(parts) == 2:
            parent, name = "/" + parts[0], parts[1]
        else:
            parent, name = "/", parts[0]
        resource_type = "folder" if entry.type == "tree" else "file"
        idx_entry = IndexEntry(
            id=entry.sha,
            name=name,
            resource_type=resource_type,
            size=entry.size,
        )
        dirs[parent].append((name, idx_entry))
    for parent, entries in dirs.items():
        index._entries.update({
            ("/" + parent.strip("/") + "/" + name).replace("//", "/"):
            e
            for name, e in entries
        })
        child_keys = sorted(
            ("/" + parent.strip("/") + "/" + name).replace("//", "/")
            for name, _ in entries)
        index._children[parent] = child_keys
        index._expiry[parent] = datetime.now(
            timezone.utc) + timedelta(days=365)
    return index


@pytest.fixture
def tree():
    return {
        "src":
        TreeEntry(path="src", type="tree", sha="aaa", size=None),
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="bbb", size=120),
        "src/utils":
        TreeEntry(path="src/utils", type="tree", sha="ccc", size=None),
        "src/utils/helpers.py":
        TreeEntry(path="src/utils/helpers.py", type="blob", sha="ddd",
                  size=80),
        "README.md":
        TreeEntry(path="README.md", type="blob", sha="eee", size=50),
    }


@pytest.mark.asyncio
async def test_readdir_root(tree):
    index = _index_from_tree(tree)
    result = await readdir(None,
                           PathSpec(vfs_path="", virtual="/", directory="/"),
                           index)
    assert result == ["/README.md", "/src"]


@pytest.mark.asyncio
async def test_readdir_subdirectory(tree):
    index = _index_from_tree(tree)
    result = await readdir(
        None, PathSpec(vfs_path="src", virtual="/src", directory="/src"),
        index)
    assert result == ["/src/main.py", "/src/utils"]


@pytest.mark.asyncio
async def test_readdir_nested(tree):
    index = _index_from_tree(tree)
    result = await readdir(
        None,
        PathSpec(vfs_path="src/utils",
                 virtual="/src/utils",
                 directory="/src/utils"), index)
    assert result == ["/src/utils/helpers.py"]


@pytest.mark.asyncio
async def test_readdir_missing_directory(tree):
    index = _index_from_tree(tree)
    accessor = MagicMock()
    accessor.truncated = False
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(vfs_path="nonexistent",
                     virtual="/nonexistent",
                     directory="/nonexistent"), index)


# The index *is* the listing here, seeded once from the recursive tree, so
# an expired one is a tree that aged out rather than a repository that
# emptied. Before the refill, `ls /repo` exited 0 with no output once the
# day-long TTL lapsed, and reported the mount root missing after a `gh`
# write invalidated it.
@pytest.mark.asyncio
async def test_readdir_refills_an_expired_index(tree, monkeypatch):
    index = _index_from_tree(tree)
    await index.invalidate()
    calls = []

    async def fake_fetch_tree(config, owner, repo, ref, session=None):
        calls.append((owner, repo, ref))
        return tree, False

    monkeypatch.setattr(mirage.core.github.tree, "fetch_tree", fake_fetch_tree)
    accessor = MagicMock()
    accessor.truncated = False
    result = await readdir(accessor,
                           PathSpec(vfs_path="", virtual="/", directory="/"),
                           index)
    assert result == ["/README.md", "/src"]
    assert len(calls) == 1


# A miss against a live index is a real absence, so it must stay one call
# of nothing: refilling here would spend a full recursive-tree fetch on
# every ENOENT.
@pytest.mark.asyncio
async def test_readdir_does_not_refill_on_a_real_miss(tree, monkeypatch):
    index = _index_from_tree(tree)
    calls = []

    async def fake_fetch_tree(config, owner, repo, ref, session=None):
        calls.append((owner, repo, ref))
        return tree, False

    monkeypatch.setattr(mirage.core.github.tree, "fetch_tree", fake_fetch_tree)
    accessor = MagicMock()
    accessor.truncated = False
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(vfs_path="nonexistent",
                     virtual="/nonexistent",
                     directory="/nonexistent"), index)
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize("replacement", ["tree", "blob", "missing"])
async def test_truncated_tree_refills_expired_directory(
        backend, replacement, monkeypatch):
    client = FakeRedis()
    index = RAMIndexCacheStore() if backend == "ram" else RedisIndexCacheStore(
        client=client)
    await index.set_dir("/repo", [
        ("src", IndexEntry(id="old-src", name="src", resource_type="folder"))
    ])
    await index.set_dir(
        "/repo/src",
        [("nested",
          IndexEntry(id="old-nested", name="nested", resource_type="folder"))])
    await index.set_dir("/repo/src/nested", [],
                        datetime.now(timezone.utc) - timedelta(seconds=1))
    parent = [] if replacement == "missing" else [
        TreeEntry(path="nested", type=replacement, sha="new-nested", size=None)
    ]
    fetch = AsyncMock(side_effect=[
        [TreeEntry(path="src", type="tree", sha="new-src", size=None)],
        parent,
        [TreeEntry(path="new.py", type="blob", sha="new", size=2)],
    ])
    monkeypatch.setitem(readdir.__globals__, "fetch_dir_tree", fetch)
    blob_fetch = AsyncMock(return_value=b"replacement")
    monkeypatch.setitem(read.__globals__, "read_bytes", blob_fetch)
    accessor = MagicMock()
    accessor.ref = "main"
    accessor.truncated = True
    path = PathSpec(vfs_path="src/nested",
                    virtual="/repo/src/nested",
                    directory="/repo/src/nested")
    try:
        if replacement == "tree":
            for _ in range(2):
                assert await readdir(accessor, path,
                                     index) == ["/repo/src/nested/new.py"]
            assert [call.args[3] for call in fetch.await_args_list
                    ] == ["main", "new-src", "new-nested"]
        else:
            with pytest.raises(FileNotFoundError):
                await readdir(accessor, path, index)
            if replacement == "blob":
                assert (await stat(accessor, path,
                                   index)).type == FileType.FILE
                assert await read(accessor, path, index) == b"replacement"
                assert blob_fetch.await_args.args[3] == "new-nested"
            else:
                for reader in (stat, read):
                    with pytest.raises(FileNotFoundError):
                        await reader(accessor, path, index)
            assert [call.args[3]
                    for call in fetch.await_args_list] == ["main", "new-src"]
    finally:
        await index.close()
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize("replacement", ["missing", "blob"])
async def test_complete_refill_removes_obsolete_directories(
        backend, replacement, monkeypatch):
    client = FakeRedis()
    index = RAMIndexCacheStore() if backend == "ram" else RedisIndexCacheStore(
        client=client)
    accessor = MagicMock()
    accessor.truncated = False
    tree = {} if replacement == "missing" else {
        "src": TreeEntry(path="src", type="blob", sha="new", size=3)
    }
    fetch = AsyncMock(return_value=(tree, False))
    monkeypatch.setattr(mirage.core.github.tree, "fetch_tree", fetch)
    path = PathSpec(vfs_path="src", virtual="/repo/src", directory="/repo/src")
    try:
        await index.set_dir("/other", [
            ("keep", IndexEntry(id="keep", name="keep", resource_type="file"))
        ])
        await index.set_dir("/repo", [
            ("src", IndexEntry(id="old", name="src", resource_type="folder"))
        ])
        await index.set_dir(
            "/repo/src",
            [("old.py",
              IndexEntry(id="old-file", name="old.py", resource_type="file"))])
        await index.invalidate()
        for _ in range(2):
            with pytest.raises(FileNotFoundError):
                await readdir(accessor, path, index)
        fetch.assert_awaited_once()
        assert (await index.get("/repo/src/old.py")).entry is None
        assert (await index.get("/other/keep")).entry.id == "keep"
    finally:
        await index.close()
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize("prefix", ["", "/repo"])
@pytest.mark.parametrize("partial_children", [False, True])
@pytest.mark.parametrize("refresh", [False, True])
async def test_truncated_refill_does_not_cache_partial_listings(
        backend, prefix, partial_children, refresh, monkeypatch):
    client = FakeRedis()
    index = RAMIndexCacheStore() if backend == "ram" else RedisIndexCacheStore(
        client=client)
    root = prefix or "/"
    folder = TreeEntry(path="docs", type="tree", sha="docs-sha", size=None)
    partial_tree = {"docs": folder}
    if partial_children:
        partial_tree["docs/first.md"] = TreeEntry(path="docs/first.md",
                                                  type="blob",
                                                  sha="first",
                                                  size=1)
    tree_fetch = AsyncMock(return_value=(partial_tree, True))
    dir_fetch = AsyncMock(side_effect=[
        [folder], [folder],
        [
            TreeEntry(path="first.md", type="blob", sha="first", size=1),
            TreeEntry(path="second.md", type="blob", sha="second", size=2),
        ]
    ])
    monkeypatch.setattr(mirage.core.github.tree, "fetch_tree", tree_fetch)
    monkeypatch.setitem(readdir.__globals__, "fetch_dir_tree", dir_fetch)
    accessor = MagicMock()
    accessor.ref = "main"
    accessor.truncated = False
    root_path = PathSpec(vfs_path="", virtual=root, directory=root)
    docs = prefix + "/docs"
    docs_path = PathSpec(vfs_path="docs", virtual=docs, directory=docs)
    try:
        if refresh:
            await index.set_dir(root, [])
            await index.invalidate()
        for _ in range(2):
            assert await readdir(accessor, root_path, index) == [docs]
            assert await readdir(accessor, docs_path, index) == [
                docs + "/first.md", docs + "/second.md"
            ]
        tree_fetch.assert_awaited_once()
        assert [call.args[3] for call in dir_fetch.await_args_list
                ] == ["main", "main", "docs-sha"]
    finally:
        await index.close()
        await client.aclose()
