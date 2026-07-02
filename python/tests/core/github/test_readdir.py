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
from unittest.mock import MagicMock

import pytest

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.readdir import readdir
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec


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
    result = await readdir(
        None, PathSpec(resource_path="", virtual="/", directory="/"), index)
    assert result == ["/README.md", "/src"]


@pytest.mark.asyncio
async def test_readdir_subdirectory(tree):
    index = _index_from_tree(tree)
    result = await readdir(
        None, PathSpec(resource_path="src", virtual="/src", directory="/src"),
        index)
    assert result == ["/src/main.py", "/src/utils"]


@pytest.mark.asyncio
async def test_readdir_nested(tree):
    index = _index_from_tree(tree)
    result = await readdir(
        None,
        PathSpec(resource_path="src/utils",
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
            PathSpec(resource_path="nonexistent",
                     virtual="/nonexistent",
                     directory="/nonexistent"), index)
