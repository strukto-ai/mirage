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
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fakeredis.aioredis import FakeRedis

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.core.github.read import read
from mirage.core.github.readdir import readdir
from mirage.core.github.stat import stat
from mirage.core.github.tree import index_rows
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import ContentType, FileType, PathSpec


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
        "README.md":
        TreeEntry(path="README.md", type="blob", sha="ccc", size=50),
    }


@pytest.mark.asyncio
async def test_stat_file(tree):
    index = _index_from_tree(tree)
    result = await stat(
        None,
        PathSpec(vfs_path="src/main.py",
                 virtual="/src/main.py",
                 directory="/src/main.py"), index)
    assert result.name == "main.py"
    assert result.size == 120
    assert result.content == ContentType.TEXT
    assert result.extra == {"sha": "bbb"}


@pytest.mark.asyncio
async def test_stat_directory(tree):
    index = _index_from_tree(tree)
    result = await stat(
        None, PathSpec(vfs_path="src", virtual="/src", directory="/src"),
        index)
    assert result.name == "src"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_root(tree):
    index = _index_from_tree(tree)
    result = await stat(None, PathSpec(vfs_path="", virtual="/",
                                       directory="/"), index)
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_not_found(tree):
    index = _index_from_tree(tree)
    with pytest.raises(FileNotFoundError):
        await stat(
            None,
            PathSpec(vfs_path="nonexistent.py",
                     virtual="/nonexistent.py",
                     directory="/nonexistent.py"), index)


@pytest.mark.asyncio
async def test_stat_strip_slashes(tree):
    index = _index_from_tree(tree)
    result = await stat(
        None,
        PathSpec(vfs_path="README.md",
                 virtual="/README.md",
                 directory="/README.md"), index)
    assert result.name == "README.md"
    assert result.size == 50


@pytest.mark.asyncio
async def test_stat_propagates_parent_refresh_failure():
    failure = RuntimeError("github unavailable")
    with patch("mirage.core.github.stat._readdir",
               new_callable=AsyncMock,
               side_effect=failure):
        with pytest.raises(RuntimeError, match="github unavailable"):
            await stat(None, PathSpec.from_str_path("/missing.py"),
                       RAMIndexCacheStore())


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
@pytest.mark.parametrize("truncated", [False, True])
@pytest.mark.parametrize("deleted", [False, True])
@pytest.mark.parametrize("reader", [stat, read])
async def test_direct_lookup_after_invalidation(backend, truncated, deleted,
                                                reader, monkeypatch):
    client = FakeRedis()
    index = RAMIndexCacheStore() if backend == "ram" else RedisIndexCacheStore(
        client=client)
    accessor = MagicMock()
    accessor.ref = "main"
    accessor.truncated = truncated
    old_tree = {
        "src":
        TreeEntry(path="src", type="tree", sha="old-tree", size=None),
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="old-blob", size=3),
    }
    entries, children = index_rows(old_tree, "/repo")
    index.seed(entries, children,
               datetime.now(timezone.utc) + timedelta(days=1))
    new_tree = {
        "src": TreeEntry(path="src", type="tree", sha="new-tree", size=None)
    }
    new_files = [] if deleted else [
        TreeEntry(path="main.py", type="blob", sha="new-blob", size=9)
    ]
    if not deleted:
        new_tree["src/main.py"] = TreeEntry(path="src/main.py",
                                            type="blob",
                                            sha="new-blob",
                                            size=9)
    tree_fetch = AsyncMock(return_value=(new_tree, False))
    dir_fetch = AsyncMock(side_effect=[[new_tree["src"]], new_files])
    blob_fetch = AsyncMock(return_value=b"new bytes")
    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", tree_fetch)
    monkeypatch.setitem(readdir.__globals__, "fetch_dir_tree", dir_fetch)
    monkeypatch.setitem(read.__globals__, "read_bytes", blob_fetch)
    path = PathSpec(vfs_path="src/main.py",
                    virtual="/repo/src/main.py",
                    directory="/repo/src")
    try:
        await index.invalidate()
        for _ in range(2):
            if deleted:
                with pytest.raises(FileNotFoundError):
                    await reader(accessor, path, index)
            elif reader is stat:
                result = await stat(accessor, path, index)
                assert result.size == 9
                assert result.fingerprint == "new-blob"
                assert result.extra == {"sha": "new-blob"}
            else:
                assert await read(accessor, path, index) == b"new bytes"
        if reader is read and not deleted:
            assert all(call.args[3] == "new-blob"
                       for call in blob_fetch.await_args_list)
        else:
            blob_fetch.assert_not_awaited()
        assert tree_fetch.await_count == (0 if truncated else 1)
        assert dir_fetch.await_count == (2 if truncated else 0)
        if truncated:
            assert [call.args[3] for call in dir_fetch.await_args_list
                    ] == ["main", "new-tree"]
    finally:
        await index.close()
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_parallel_snapshot_readers_share_one_replacement(
        backend, monkeypatch):
    import asyncio

    from mirage.accessor.github import GitHubAccessor
    from mirage.core.github.config import GitHubConfig

    client = FakeRedis()
    index = RAMIndexCacheStore() if backend == "ram" else RedisIndexCacheStore(
        client=client)
    accessor = GitHubAccessor(GitHubConfig(token="test"),
                              "acme",
                              "repo",
                              ref="main")
    fresh = {"a.txt": TreeEntry(path="a.txt", type="blob", sha="new", size=9)}

    async def fetch(*args):
        await asyncio.sleep(0)
        return fresh, False

    fetch_mock = AsyncMock(side_effect=fetch)
    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", fetch_mock)
    path = PathSpec(virtual="/repo/a.txt", directory="/repo", vfs_path="a.txt")
    root = PathSpec(virtual="/repo", directory="/repo", vfs_path="")
    try:
        await index.set_dir("/repo", [
            ("a.txt", IndexEntry(id="old", name="a.txt", resource_type="file"))
        ])
        await index.invalidate()
        results = await asyncio.gather(
            *(stat(accessor, path, index) for _ in range(8)),
            readdir(accessor, root, index))
        assert [row.fingerprint for row in results[:-1]] == ["new"] * 8
        assert results[-1] == ["/repo/a.txt"]
        fetch_mock.assert_awaited_once()
    finally:
        await index.close()
        await client.aclose()
