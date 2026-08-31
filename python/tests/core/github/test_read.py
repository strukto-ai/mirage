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

import base64
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import mirage.core.github.read
import mirage.core.github.tree
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.config import GitHubConfig
from mirage.core.github.read import read, read_bytes
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@pytest.mark.asyncio
@patch("mirage.core.github.read.github_get", new_callable=AsyncMock)
async def test_read_bytes_utf8(mock_get, config):
    content = b"hello world"
    mock_get.return_value = {"content": base64.b64encode(content).decode()}
    result = await read_bytes(config, "acme", "proj", "sha123")
    assert result == content
    assert result.decode("utf-8") == "hello world"


@pytest.mark.asyncio
@patch("mirage.core.github.read.github_get", new_callable=AsyncMock)
async def test_read_bytes_binary(mock_get, config):
    content = bytes(range(256))
    mock_get.return_value = {"content": base64.b64encode(content).decode()}
    result = await read_bytes(config, "acme", "proj", "sha456")
    assert result == content


def _index() -> RAMIndexCacheStore:
    index = RAMIndexCacheStore()
    entry = IndexEntry(id="bbb", name="main.py", resource_type="file", size=3)
    index._entries["/src/main.py"] = entry
    index._children["/src"] = ["/src/main.py"]
    index._expiry["/src"] = datetime.now(timezone.utc) + timedelta(days=365)
    # The root row is what makes this a live index rather than a dropped
    # one; without it every read here would be a refill, which is the
    # distinction ensure_live_index draws.
    index._entries["/src"] = IndexEntry(id="aaa",
                                        name="src",
                                        resource_type="folder")
    index._children["/"] = ["/src"]
    index._expiry["/"] = datetime.now(timezone.utc) + timedelta(days=365)
    return index


# Same rule readdir follows: an expired index is a tree that aged out, so
# `cat` refetches once rather than reporting the file gone.
@pytest.mark.asyncio
async def test_read_refills_an_expired_index(monkeypatch):
    index = _index()
    await index.invalidate()
    calls = []

    async def fake_fetch_tree(config, owner, repo, ref, session=None):
        calls.append(ref)
        return {
            "src":
            TreeEntry(path="src", type="tree", sha="aaa", size=None),
            "src/main.py":
            TreeEntry(path="src/main.py", type="blob", sha="bbb", size=3),
        }, False

    async def fake_read_bytes(config, owner, repo, sha, session=None):
        return b"hi\n"

    monkeypatch.setattr(mirage.core.github.tree, "fetch_tree", fake_fetch_tree)
    monkeypatch.setattr(mirage.core.github.read, "read_bytes", fake_read_bytes)
    accessor = MagicMock()
    accessor.truncated = False
    out = await read(
        accessor,
        PathSpec(resource_path="src/main.py",
                 virtual="/src/main.py",
                 directory="/src"), index)
    assert out == b"hi\n"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_read_does_not_refill_on_a_real_miss(monkeypatch):
    index = _index()
    calls = []

    async def fake_fetch_tree(config, owner, repo, ref, session=None):
        calls.append(ref)
        return {}, False

    monkeypatch.setattr(mirage.core.github.tree, "fetch_tree", fake_fetch_tree)
    accessor = MagicMock()
    accessor.truncated = False
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(resource_path="src/gone.py",
                     virtual="/src/gone.py",
                     directory="/src"), index)
    assert calls == []
