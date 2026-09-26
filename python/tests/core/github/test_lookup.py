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

import copy

import aiohttp
import pytest
from fakeredis.aioredis import FakeRedis

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import NULL_INDEX, IndexEntry, ListResult, LookupStatus
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.core.github import lookup as lookup_mod
from mirage.core.github.config import GitHubConfig
from mirage.core.github.lookup import point_lookup
from mirage.core.github.stat import stat
from mirage.core.github.tree import fetch_tree, refill_index
from mirage.types import FileType, PathSpec
from tests.fixtures.github_api import FakeGitHub, blob_sha, race_index, serve

FILES = {
    "README.md": b"hello",
    "docs/a.txt": b"alpha",
    "docs/sub/b.txt": b"bravo",
    "docs/link.txt": b"a.txt",
}


def _accessor(gh: FakeGitHub, **kwargs) -> GitHubAccessor:
    return GitHubAccessor(GitHubConfig(token="t", base_url=gh.url), "o", "r",
                          "main", **kwargs)


def _spec(rel: str, prefix: str = "/gh") -> PathSpec:
    virtual = prefix + "/" + rel
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0],
                    vfs_path=rel)


@pytest.fixture
def gh():
    with serve(FakeGitHub(files=dict(FILES),
                          symlinks={"docs/link.txt"})) as hub:
        yield hub


async def _store(backend: str):
    if backend == "ram":
        return RAMIndexCacheStore(), None
    client = FakeRedis()
    return RedisIndexCacheStore(client=client), client


async def _close(index, client) -> None:
    await index.close()
    if client is not None:
        await client.aclose()


async def _listed(gh: FakeGitHub, index) -> GitHubAccessor:
    accessor = _accessor(gh)
    await refill_index(accessor, index, "/gh")
    gh.log.clear()
    return accessor


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_a_probe_after_the_mount_listed_asks_one_directory(gh, backend):
    index, client = await _store(backend)
    try:
        accessor = await _listed(gh, RAMIndexCacheStore())
        result = await stat(accessor, _spec("docs/a.txt"), index)
        assert result.fingerprint == blob_sha(b"alpha")
        # One shallow listing of the parent, never the whole repository.
        assert gh.counts() == (1, 0, 0)
    finally:
        await _close(index, client)


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_a_live_index_answers_without_a_request(gh, backend):
    index, client = await _store(backend)
    try:
        accessor = await _listed(gh, index)
        result = await stat(accessor, _spec("docs/a.txt"), index)
        assert result.fingerprint == blob_sha(b"alpha")
        assert gh.counts() == (0, 0, 0)
    finally:
        await _close(index, client)


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_an_expired_index_refills_rather_than_asking_one_directory(
        gh, backend):
    index, client = await _store(backend)
    try:
        accessor = await _listed(gh, index)
        await index.invalidate()
        await stat(accessor, _spec("docs/a.txt"), index)
        assert gh.counts() == (0, 1, 0)
    finally:
        await _close(index, client)


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["ram", "redis"])
async def test_a_mount_that_never_listed_walks_and_seeds(gh, backend):
    index, client = await _store(backend)
    try:
        accessor = _accessor(gh)
        await stat(accessor, _spec("docs/a.txt"), index)
        assert gh.counts() == (0, 1, 0)
        assert (await index.list_dir("/gh")).entries is not None
    finally:
        await _close(index, client)


@pytest.mark.asyncio
async def test_a_mount_built_with_its_tree_still_walks_first(gh):
    # tree_loaded is true here while nothing has been listed into an index,
    # which is what separates the refill count from the draft's tree_loaded
    # gate.
    tree, _ = await fetch_tree(GitHubConfig(token="t", base_url=gh.url), "o",
                               "r", "main")
    accessor = _accessor(gh, tree=tree)
    gh.log.clear()
    assert accessor.tree_loaded
    await stat(accessor, _spec("docs/a.txt"), RAMIndexCacheStore())
    assert gh.counts() == (0, 1, 0)


@pytest.mark.asyncio
async def test_no_index_never_asks_one_directory(gh):
    accessor = await _listed(gh, RAMIndexCacheStore())
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _spec("docs/a.txt"), NULL_INDEX)
    assert gh.counts() == (0, 0, 0)


@pytest.mark.asyncio
async def test_the_gate_keys_on_the_root_listing_not_on_emptiness(gh):
    accessor = await _listed(gh, RAMIndexCacheStore())
    index = RAMIndexCacheStore()
    await index.set_dir(
        "/gh/other",
        [("x", IndexEntry(id="x", name="x", resource_type="file", size=1))])
    await stat(accessor, _spec("docs/a.txt"), index)
    assert gh.counts() == (1, 0, 0)


class _OrderedIndex(RAMIndexCacheStore):

    def __init__(self, order: list[str]) -> None:
        super().__init__()
        self.order = order

    async def list_dir(self, vfs_path: str) -> ListResult:
        self.order.append(f"list:{vfs_path}")
        return await super().list_dir(vfs_path)


class _CountingAccessor(GitHubAccessor):

    @property
    def refills(self) -> int:
        self.order.append("refills")
        return self._refills

    @refills.setter
    def refills(self, value: int) -> None:
        self._refills = value


@pytest.mark.asyncio
async def test_the_gate_reads_the_root_before_the_accessor(gh):
    order: list[str] = []
    accessor = _CountingAccessor(GitHubConfig(token="t", base_url=gh.url), "o",
                                 "r", "main")
    accessor.order = order
    accessor.refills = 1
    live = _OrderedIndex(order)
    await refill_index(accessor, live, "/gh")
    order.clear()
    # A live root answers without the accessor being consulted at all.
    assert await point_lookup(accessor, live, "/gh", "docs/a.txt") is None
    assert order == ["list:/gh"]
    order.clear()
    found = await point_lookup(accessor, _OrderedIndex(order), "/gh",
                               "docs/a.txt")
    assert found is not None and found.entry is not None
    assert order[:2] == ["list:/gh", "refills"]


@pytest.mark.asyncio
async def test_a_point_stat_writes_nothing(gh):
    accessor = await _listed(gh, RAMIndexCacheStore())
    tree = accessor.tree
    snapshot = copy.deepcopy(tree)
    state = (accessor.tree_loaded, accessor.truncated, accessor.refills)
    index = RAMIndexCacheStore()
    await stat(accessor, _spec("docs/a.txt"), index)
    assert accessor.tree is tree
    assert accessor.tree == snapshot
    assert (accessor.tree_loaded, accessor.truncated,
            accessor.refills) == state
    assert (await index.list_dir("/gh")).status == LookupStatus.NOT_FOUND
    assert (await index.list_dir("/gh/docs")).status == LookupStatus.NOT_FOUND
    assert (await index.get("/gh/docs/a.txt")).entry is None


@pytest.mark.asyncio
@pytest.mark.parametrize("rel", [
    "README.md", "docs/a.txt", "docs/sub/b.txt", "docs/link.txt", "docs",
    "docs/sub"
])
async def test_the_point_row_renders_as_the_tree_row(gh, rel):
    listed = await _listed(gh, RAMIndexCacheStore())
    by_point = await stat(listed, _spec(rel), RAMIndexCacheStore())
    assert gh.counts() == (1, 0, 0)
    by_tree = await stat(_accessor(gh), _spec(rel), RAMIndexCacheStore())
    fields = ("name", "type", "size", "fingerprint", "content")
    assert ({
        f: getattr(by_point, f)
        for f in fields
    } == {
        f: getattr(by_tree, f)
        for f in fields
    })
    if rel == "docs/link.txt":
        # A symlink row is the link's own blob: its sha and the length of
        # its text, which is what a read of it returns.
        assert by_point.size == len(b"a.txt")
    if rel in ("docs", "docs/sub"):
        assert by_point.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_a_point_stat_of_a_missing_file_is_enoent_without_a_walk(gh):
    accessor = await _listed(gh, RAMIndexCacheStore())
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _spec("docs/nope.txt"), RAMIndexCacheStore())
    assert gh.counts() == (1, 0, 0)


@pytest.mark.asyncio
async def test_a_missing_directory_defers_to_the_tree(gh):
    accessor = await _listed(gh, RAMIndexCacheStore())
    gh.fail["dir"] = (404, "Not Found")
    result = await stat(accessor, _spec("docs/a.txt"), RAMIndexCacheStore())
    assert result.fingerprint == blob_sha(b"alpha")
    assert gh.counts() == (1, 1, 0)


@pytest.mark.asyncio
async def test_a_repository_it_cannot_see_is_an_error_not_absence(gh):
    accessor = await _listed(gh, RAMIndexCacheStore())
    # Lost access and a deleted ref answer 404 on both endpoints.
    gh.fail["dir"] = (404, "Not Found")
    gh.fail["recursive"] = (404, "Not Found")
    with pytest.raises(aiohttp.ClientResponseError) as caught:
        await stat(accessor, _spec("docs/a.txt"), RAMIndexCacheStore())
    assert caught.value.status == 404
    assert not isinstance(caught.value, FileNotFoundError)


@pytest.mark.asyncio
async def test_a_refused_token_raises_without_a_walk(gh):
    accessor = await _listed(gh, RAMIndexCacheStore())
    gh.fail["dir"] = (401, "Bad credentials")
    with pytest.raises(aiohttp.ClientResponseError) as caught:
        await stat(accessor, _spec("docs/a.txt"), RAMIndexCacheStore())
    assert caught.value.status == 401
    assert gh.counts() == (1, 0, 0)


@pytest.mark.asyncio
async def test_a_truncated_listing_without_the_row_defers(gh):
    accessor = await _listed(gh, RAMIndexCacheStore())
    gh.truncated_dirs["docs"] = 0
    result = await stat(accessor, _spec("docs/a.txt"), RAMIndexCacheStore())
    assert result.fingerprint == blob_sha(b"alpha")
    assert gh.counts() == (1, 1, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["list", "stale", "get", "reseed"])
async def test_a_stat_retries_when_the_index_changes_under_it(gh, kind):
    index = race_index(kind)
    accessor = await _listed(gh, index)
    index.accessor = accessor
    index.fired = False
    result = await stat(accessor, _spec("docs/sub/b.txt"), index)
    assert result.fingerprint == blob_sha(b"bravo")
    # The retry asks the index again, so a cleared store refills once.
    assert gh.counts() == (0, 1, 0)


@pytest.mark.asyncio
async def test_a_genuine_miss_is_asked_once(gh, monkeypatch):
    index = RAMIndexCacheStore()
    accessor = await _listed(gh, index)
    calls: list[str] = []
    real = lookup_mod.lookup

    async def counting(*args, **kwargs):
        calls.append(args[3])
        return await real(*args, **kwargs)

    monkeypatch.setitem(lookup_mod.lookup_retrying.__globals__, "lookup",
                        counting)
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _spec("docs/sub/nope.txt"), index)
    assert calls == ["/gh/docs/sub/nope.txt"]
    assert gh.counts() == (0, 0, 0)


@pytest.mark.asyncio
async def test_a_miss_without_an_index_is_not_retried(gh, monkeypatch):
    accessor = await _listed(gh, RAMIndexCacheStore())
    calls: list[str] = []
    real = lookup_mod.lookup

    async def counting(*args, **kwargs):
        calls.append(args[3])
        return await real(*args, **kwargs)

    monkeypatch.setitem(lookup_mod.lookup_retrying.__globals__, "lookup",
                        counting)
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _spec("docs/sub/b.txt"), NULL_INDEX)
    assert len(calls) == 1
