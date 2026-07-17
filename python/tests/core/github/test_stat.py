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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
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
        "README.md":
        TreeEntry(path="README.md", type="blob", sha="ccc", size=50),
    }


@pytest.mark.asyncio
async def test_stat_file(tree):
    index = _index_from_tree(tree)
    result = await stat(
        None,
        PathSpec(resource_path="src/main.py",
                 virtual="/src/main.py",
                 directory="/src/main.py"), index)
    assert result.name == "main.py"
    assert result.size == 120
    assert result.type == FileType.TEXT
    assert result.extra == {"sha": "bbb"}


@pytest.mark.asyncio
async def test_stat_directory(tree):
    index = _index_from_tree(tree)
    result = await stat(
        None, PathSpec(resource_path="src", virtual="/src", directory="/src"),
        index)
    assert result.name == "src"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_root(tree):
    index = _index_from_tree(tree)
    result = await stat(None,
                        PathSpec(resource_path="", virtual="/", directory="/"),
                        index)
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_not_found(tree):
    index = _index_from_tree(tree)
    with pytest.raises(FileNotFoundError):
        await stat(
            None,
            PathSpec(resource_path="nonexistent.py",
                     virtual="/nonexistent.py",
                     directory="/nonexistent.py"), index)


@pytest.mark.asyncio
async def test_stat_strip_slashes(tree):
    index = _index_from_tree(tree)
    result = await stat(
        None,
        PathSpec(resource_path="README.md",
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
