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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.config import GitHubConfig
from mirage.core.github.readdir import readdir
from mirage.core.github.tree import ensure_tree
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.github.github import GitHubVFS
from mirage.workspace import Workspace
from mirage.workspace.reconcile import Reconciler

CONFIG = GitHubConfig(token="ghp_test")
TREE = {
    "src": TreeEntry(path="src", type="tree", sha="a", size=None),
    "src/main.py": TreeEntry(path="src/main.py", type="blob", sha="b",
                             size=10),
}


@pytest.fixture
def tree_calls(monkeypatch):
    calls = []

    async def _fetch_tree(config, owner, repo, ref, session=None):
        calls.append((owner, repo, ref))
        return dict(TREE), False

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", _fetch_tree)
    return calls


@pytest.mark.asyncio
async def test_first_readdir_costs_one_tree_fetch(tree_calls):
    # Building used to fetch the tree and nothing seeded the index with
    # it, so the first readdir refetched and threw the first away. Two
    # `git/trees` calls where one does; hydrating lazily removes one.
    vfs = GitHubVFS(CONFIG, "o", "r", "main")
    assert tree_calls == []

    index = RAMIndexCacheStore()
    entries = await readdir(vfs.accessor,
                            PathSpec(vfs_path="", virtual="/", directory="/"),
                            index)
    assert sorted(entries) == ["/src"]
    assert len(tree_calls) == 1


@pytest.mark.asyncio
async def test_an_empty_repo_hydrates_once(tree_calls, monkeypatch):
    # Hydration was tracked by whether the tree held anything, so an
    # empty repository read as "never hydrated" and refetched forever:
    # twice per call with an index wired, since the refill seeds an empty
    # root and then the fallback runs anyway.
    async def _empty(config, owner, repo, ref, session=None):
        tree_calls.append((owner, repo, ref))
        return {}, False

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", _empty)
    vfs = GitHubVFS(CONFIG, "o", "r", "main")
    index = RAMIndexCacheStore()
    for _ in range(3):
        await ensure_tree(vfs.accessor, index, "/gh")
    assert vfs.accessor.tree == {}
    assert vfs.accessor.tree_loaded is True
    assert len(tree_calls) == 1


@pytest.mark.asyncio
async def test_a_tree_passed_to_the_constructor_counts_as_hydrated(tree_calls):
    # A caller holding the answer (a test, a snapshot restore) must not
    # trigger a fetch on the first direct-tree command.
    vfs = GitHubVFS(CONFIG, "o", "r", "main", tree=dict(TREE))
    await ensure_tree(vfs.accessor)
    assert tree_calls == []


@pytest.fixture
def default_branch(monkeypatch):

    async def _fetch(config, owner, repo, session=None):
        return "master"

    monkeypatch.setattr("mirage.core.github.repo.fetch_default_branch", _fetch)


@pytest.mark.asyncio
async def test_a_mount_naming_no_ref_reads_the_repos_default_branch(
        tree_calls, default_branch):
    # The config used to default `ref` to the literal string "main", so a
    # repository whose default branch is anything else 404d on the one
    # request the whole mount is built on and the mount read as empty.
    vfs = GitHubVFS(GitHubConfig(token="ghp_test", owner="o", repo="r"))
    assert vfs.accessor.ref is None
    await ensure_tree(vfs.accessor)
    assert tree_calls == [("o", "r", "master")]


@pytest.mark.asyncio
async def test_an_unpinned_mount_is_on_the_default_branch_before_any_fetch(
        tree_calls):
    # Naming no ref *means* following the default branch, so the two agree
    # whatever it turns out to be -- no request, and not the "not known
    # yet" None a pinned mount answers.
    vfs = GitHubVFS(GitHubConfig(token="ghp_test", owner="o", repo="r"))
    assert vfs.is_default_branch is True
    assert GitHubVFS(CONFIG, "o", "r", "dev").is_default_branch is None


@pytest.mark.asyncio
async def test_reconcile_private_index_can_resolve_github_ids(tree_calls):
    # The subject is the reconciler's github-id resolution, not github's
    # place on the revalidatable roster: the instance declares the
    # capability so the mount can legally carry `read: fresh`.
    vfs = GitHubVFS(CONFIG, "o", "r", "main")
    vfs.READ_REVALIDATABLE = True
    ws = Workspace({"/gh": vfs}, read=ReadSpec(policy=ReadPolicy.FRESH))
    try:
        path = "/gh/src/main.py"
        await ws.namespace.ensure_loaded()
        mount = ws.namespace.mount_for(path)
        await mount.execute_op("stat", path)
        await ws.cache.set(path, b"cached", fingerprint="b")
        await ws.namespace.set_attrs(path, mode=0o600)
        rec = Reconciler(ws.cache, ws.namespace)
        await rec.reconcile_read(mount, path)
        assert await ws.cache.exists(path)
        assert ws.namespace.meta_for(path) is not None
        assert len(tree_calls) == 2
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("surface", ["shell", "fs"])
async def test_always_reads_current_github_blob_after_probe(
        monkeypatch, surface):
    sha = "v1"

    async def fetch_tree(*args, **kwargs):
        return {
            "f.txt": TreeEntry(path="f.txt", type="blob", sha=sha, size=2)
        }, False

    async def read_bytes(config, owner, repo, blob_sha, session=None):
        return blob_sha.encode()

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", fetch_tree)
    monkeypatch.setattr("mirage.core.github.read.read_bytes", read_bytes)
    vfs = GitHubVFS(CONFIG, "o", "r", "main")
    vfs.READ_REVALIDATABLE = True
    ws = Workspace({"/gh": vfs}, read=ReadSpec(policy=ReadPolicy.FRESH))
    try:
        assert (await ws.shell("cat /gh/f.txt")).stdout == b"v1"
        assert (await vfs.index.get("/gh/f.txt")).entry.id == "v1"
        sha = "v2"
        if surface == "shell":
            assert (await ws.shell("cat /gh/f.txt")).stdout == b"v2"
        else:
            assert await ws.vfs.read("/gh/f.txt") == b"v2"
    finally:
        await ws.close()
