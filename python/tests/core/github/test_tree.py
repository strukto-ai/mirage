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

import logging
from unittest.mock import patch

import pytest

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import NULL_INDEX
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.github.config import GitHubConfig
from mirage.core.github.tree import (ensure_live_index, ensure_tree,
                                     fetch_dir_tree, fetch_tree, index_rows)
from mirage.core.github.tree_entry import TreeEntry


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_parses_entries(mock_get, config):
    mock_get.return_value = {
        "truncated":
        False,
        "tree": [
            {
                "path": "src",
                "type": "tree",
                "sha": "aaa",
                "size": None
            },
            {
                "path": "src/main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 120
            },
        ],
    }
    tree, truncated = await fetch_tree(config, "acme", "proj", "main")
    assert "src" in tree
    assert "src/main.py" in tree
    assert tree["src"] == TreeEntry(path="src",
                                    type="tree",
                                    sha="aaa",
                                    size=None)
    assert tree["src/main.py"] == TreeEntry(path="src/main.py",
                                            type="blob",
                                            sha="bbb",
                                            size=120)


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_excludes_submodule_gitlinks(mock_get, config):
    mock_get.return_value = {
        "truncated":
        False,
        "tree": [
            {
                "path": "extern",
                "mode": "160000",
                "type": "commit",
                "sha": "ccc"
            },
            {
                "path": "main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 7
            },
        ],
    }
    tree, _ = await fetch_tree(config, "acme", "proj", "main")
    assert "extern" not in tree
    assert list(tree) == ["main.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_dir_tree_excludes_submodule_gitlinks(mock_get, config):
    mock_get.return_value = {
        "tree": [
            {
                "path": "extern",
                "mode": "160000",
                "type": "commit",
                "sha": "ccc"
            },
            {
                "path": "main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 7
            },
        ]
    }
    entries = await fetch_dir_tree(config, "acme", "proj", "sha1")
    assert [e.path for e in entries] == ["main.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_truncation_warning(mock_get, config, caplog):
    mock_get.return_value = {"truncated": True, "tree": []}
    with caplog.at_level(logging.WARNING):
        await fetch_tree(config, "acme", "proj", "main")
    assert "truncated" in caplog.text


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_passes_params(mock_get, config):
    mock_get.return_value = {"tree": []}
    await fetch_tree(config, "acme", "proj", "v1")
    mock_get.assert_awaited_once_with(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        params={"recursive": "1"},
        base_url=None,
        session=None,
        owner="acme",
        repo="proj",
        ref="v1",
    )


def _tree_payload() -> dict:
    return {
        "truncated":
        False,
        "tree": [
            {
                "path": "data",
                "type": "tree",
                "sha": "t1",
                "size": None
            },
            {
                "path": "data/keep.txt",
                "type": "blob",
                "sha": "b1",
                "size": 4
            },
        ],
    }


def _accessor(config):
    tree = {
        "data":
        TreeEntry(path="data", type="tree", sha="t1", size=None),
        "data/keep.txt":
        TreeEntry(path="data/keep.txt", type="blob", sha="b1", size=4),
    }
    return GitHubAccessor(config, "acme", "proj", "main", "main", tree=tree)


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_ensure_live_index_refetches_the_build_tree(mock_get, config):
    # The build tree is only true at build time: a mount's first read can
    # come long after it, so reusing it would key an index built from a
    # repository several external writes ago.
    mock_get.return_value = _tree_payload()
    index = RAMIndexCacheStore(ttl=600)
    accessor = _accessor(config)
    assert await ensure_live_index(accessor, index, "/gh") is True
    mock_get.assert_awaited_once()
    assert (await index.list_dir("/gh/data")).entries == ["/gh/data/keep.txt"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_ensure_live_index_refetches_a_dropped_listing(mock_get, config):
    mock_get.return_value = _tree_payload()
    index = RAMIndexCacheStore(ttl=600)
    accessor = _accessor(config)
    await ensure_live_index(accessor, index, "/gh")
    # What invalidation does: drop the row rather than expire it, which
    # is why the readers' EXPIRED probe never fires.
    await index.invalidate_dir("/gh")
    await index.invalidate_dir("/gh/data")
    assert await ensure_live_index(accessor, index, "/gh") is True
    assert mock_get.await_count == 2
    assert (await index.list_dir("/gh/data")).entries == ["/gh/data/keep.txt"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_ensure_live_index_leaves_a_live_index_alone(mock_get, config):
    mock_get.return_value = _tree_payload()
    index = RAMIndexCacheStore(ttl=600)
    accessor = _accessor(config)
    await ensure_live_index(accessor, index, "/gh")
    mock_get.reset_mock()
    assert await ensure_live_index(accessor, index, "/gh") is False
    mock_get.assert_not_awaited()


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_ensure_live_index_skips_a_truncated_tree(mock_get, config):
    index = RAMIndexCacheStore(ttl=600)
    accessor = _accessor(config)
    accessor.truncated = True
    assert await ensure_live_index(accessor, index, "/gh") is False
    mock_get.assert_not_awaited()


@pytest.mark.asyncio
async def test_ensure_live_index_skips_the_null_index(config):
    assert await ensure_live_index(_accessor(config), NULL_INDEX, "") is False


def test_index_rows_key_by_mount_absolute_path():
    # Every other backend keys its index this way, which is what lets the
    # shared CacheManager spell an eviction without knowing the backend.
    tree = {
        "data":
        TreeEntry(path="data", type="tree", sha="t1", size=None),
        "data/keep.txt":
        TreeEntry(path="data/keep.txt", type="blob", sha="b1", size=4),
    }
    entries, children = index_rows(tree, "/gh")
    assert sorted(entries) == ["/gh/data", "/gh/data/keep.txt"]
    assert sorted(children) == ["/gh", "/gh/data"]


def test_index_rows_root_mount_keeps_bare_paths():
    entries, children = index_rows(
        {"a.txt": TreeEntry(path="a.txt", type="blob", sha="b", size=1)}, "")
    assert sorted(entries) == ["/a.txt"]
    assert sorted(children) == ["/"]


def test_index_rows_gives_an_empty_repo_a_root_row():
    _entries, children = index_rows({}, "/gh")
    assert children == {"/gh": []}


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
@patch("mirage.core.github.tree.github_get")
async def test_an_unpinned_mount_reads_the_repos_default_branch(
        mock_tree_get, mock_repo_get, config):
    """An unresolved ref must be settled before the tree is fetched.

    ``accessor.ref`` is None until something resolves it, so reading it
    straight sends `ref=None` to the one request the whole mount is built
    on. This pins the resolution, not the config default -- the mount that
    supplies the default lives a layer up, in
    tests/resource/github/test_lazy_hydration.py.
    """
    mock_repo_get.return_value = {"default_branch": "master"}
    mock_tree_get.return_value = {"truncated": False, "tree": []}
    accessor = GitHubAccessor(config, "acme", "proj")
    await ensure_tree(accessor)
    assert mock_tree_get.await_args.kwargs["ref"] == "master"


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
@patch("mirage.core.github.tree.github_get")
async def test_a_pinned_mount_reads_its_ref_and_never_asks_for_the_branch(
        mock_tree_get, mock_repo_get, config):
    mock_tree_get.return_value = {"truncated": False, "tree": []}
    accessor = GitHubAccessor(config, "acme", "proj", "release-2")
    await ensure_tree(accessor)
    assert mock_tree_get.await_args.kwargs["ref"] == "release-2"
    mock_repo_get.assert_not_awaited()
