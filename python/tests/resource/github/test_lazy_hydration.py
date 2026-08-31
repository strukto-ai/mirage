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
from mirage.resource.github.github import GitHubResource
from mirage.types import PathSpec

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
    resource = GitHubResource(CONFIG, "o", "r", "main")
    assert tree_calls == []

    index = RAMIndexCacheStore()
    entries = await readdir(
        resource.accessor,
        PathSpec(resource_path="", virtual="/", directory="/"), index)
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
    resource = GitHubResource(CONFIG, "o", "r", "main")
    index = RAMIndexCacheStore()
    for _ in range(3):
        await ensure_tree(resource.accessor, index, "/gh")
    assert resource.accessor.tree == {}
    assert resource.accessor.tree_loaded is True
    assert len(tree_calls) == 1


@pytest.mark.asyncio
async def test_a_tree_passed_to_the_constructor_counts_as_hydrated(tree_calls):
    # A caller holding the answer (a test, a snapshot restore) must not
    # trigger a fetch on the first direct-tree command.
    resource = GitHubResource(CONFIG, "o", "r", "main", tree=dict(TREE))
    await ensure_tree(resource.accessor)
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
    resource = GitHubResource(
        GitHubConfig(token="ghp_test", owner="o", repo="r"))
    assert resource.accessor.ref is None
    await ensure_tree(resource.accessor)
    assert tree_calls == [("o", "r", "master")]


@pytest.mark.asyncio
async def test_an_unpinned_mount_is_on_the_default_branch_before_any_fetch(
        tree_calls):
    # Naming no ref *means* following the default branch, so the two agree
    # whatever it turns out to be -- no request, and not the "not known
    # yet" None a pinned mount answers.
    resource = GitHubResource(
        GitHubConfig(token="ghp_test", owner="o", repo="r"))
    assert resource.is_default_branch is True
    assert GitHubResource(CONFIG, "o", "r", "dev").is_default_branch is None
