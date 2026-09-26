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
from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import IndexEntry, LookupStatus
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.github.io import IO
from mirage.core.github.config import GitHubConfig
from mirage.core.github.read import read, read_bytes
from mirage.core.github.stat import stat
from mirage.core.github.tree import refill_index
from mirage.core.github.tree_entry import TreeEntry
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from tests.fixtures.github_api import FakeGitHub, blob_sha, race_index, serve


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
        PathSpec(vfs_path="src/main.py",
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
            PathSpec(vfs_path="src/gone.py",
                     virtual="/src/gone.py",
                     directory="/src"), index)
    assert calls == []


def _served(gh: FakeGitHub) -> GitHubAccessor:
    return GitHubAccessor(GitHubConfig(token="t", base_url=gh.url), "o", "r",
                          "main")


def _at(rel: str, prefix: str) -> PathSpec:
    virtual = (prefix.rstrip("/") + "/" + rel) if prefix != "/" else "/" + rel
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    vfs_path=rel)


# A mount at the root, one at /gh, and one named like a directory inside the
# repository, so a record labelled with anything but the virtual path lands
# on a key the cache never asks for.
@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/", "/gh", "/src"])
async def test_a_read_records_the_blob_sha_under_the_virtual_path(prefix):
    data = b"payload"
    with serve(FakeGitHub(files={"src/a.txt": data})) as gh:
        path = _at("src/a.txt", prefix)
        scope = RecordingScope()
        try:
            assert await read(_served(gh), path, RAMIndexCacheStore()) == data
        finally:
            scope.close()
        (rec, ) = scope.records
        assert (rec.op, rec.path, rec.source, rec.bytes,
                rec.fingerprint) == ("read", path.virtual, "github", len(data),
                                     blob_sha(data))
        # The stamped token is the sha the blob was fetched by.
        assert ("blob", rec.fingerprint) in gh.log


@pytest.mark.asyncio
async def test_the_synthesized_stream_records_once():
    data = b"streamed"
    with serve(FakeGitHub(files={"a.txt": data})) as gh:
        scope = RecordingScope()
        try:
            chunks = [
                c async for c in IO.read_stream(_served(gh), _at(
                    "a.txt", "/gh"), RAMIndexCacheStore())
            ]
        finally:
            scope.close()
        assert b"".join(chunks) == data
        assert [(r.op, r.fingerprint)
                for r in scope.records] == [("read", blob_sha(data))]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["list", "stale", "get", "reseed"])
async def test_a_read_retries_when_the_index_changes_under_it(kind):
    with serve(FakeGitHub(files={"docs/sub/b.txt": b"bravo"})) as gh:
        index = race_index(kind)
        accessor = _served(gh)
        await refill_index(accessor, index, "/gh")
        index.accessor = accessor
        index.fired = False
        gh.log.clear()
        assert await read(accessor, _at("docs/sub/b.txt", "/gh"),
                          index) == b"bravo"
        assert gh.counts() == (0, 1, 1)


@pytest.mark.asyncio
async def test_a_read_after_a_clear_refills_the_mount_index():
    with serve(FakeGitHub(files={"docs/a.txt": b"alpha"})) as gh:
        index = RAMIndexCacheStore()
        accessor = _served(gh)
        await refill_index(accessor, index, "/gh")
        await index.clear()
        gh.log.clear()
        assert await read(accessor, _at("docs/a.txt", "/gh"),
                          index) == b"alpha"
        # A read reseeds the listing rather than asking one directory, so
        # the stats after it are answered from the index again.
        assert gh.counts() == (0, 1, 1)
        assert (await index.list_dir("/gh")).status != LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_a_read_stamps_the_sha_it_fetched_not_a_newer_one():
    old, reseated, live = b"old", b"reseated", b"live"
    with serve(FakeGitHub(files={"a.txt": old})) as gh:
        accessor = _served(gh)
        index = RAMIndexCacheStore()
        await refill_index(accessor, index, "/gh")
        gh.files["a.txt"] = reseated
        # A refill on some other index reseats the accessor's tree only.
        await refill_index(accessor, RAMIndexCacheStore(), "/gh")
        assert accessor.tree["a.txt"].sha == blob_sha(reseated)
        gh.files["a.txt"] = live
        scope = RecordingScope()
        try:
            data = await read(accessor, _at("a.txt", "/gh"), index)
        finally:
            scope.close()
        # Three shas are in play: the mount index's, the accessor tree's and
        # the live one. Only the first names the bytes this read returned.
        assert data == old
        assert [r.fingerprint for r in scope.records] == [blob_sha(old)]
        # The probe that follows sees the live sha, which is not the one the
        # read stamped, so the copy it left is stale rather than fresh.
        probe = await stat(accessor, _at("a.txt", "/gh"), RAMIndexCacheStore())
        assert probe.fingerprint == blob_sha(live)
        assert probe.fingerprint != scope.records[0].fingerprint
