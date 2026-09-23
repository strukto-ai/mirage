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

import asyncio
from unittest.mock import patch

import pytest

from mirage.cache.index import IndexConfig
from mirage.core.github.config import GitHubConfig
from mirage.core.github.repo import ensure_default_branch
from mirage.core.github.stat import stat
from mirage.core.github.tree import ensure_tree
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import PathSpec, VFSName
from mirage.vfs.github.github import GitHubVFS

CONFIG = GitHubConfig(token="test-token")
OWNER = "test-owner"
REPO = "test-repo"


def _offline(tree: dict,
             truncated: bool = False,
             default_branch: str = "main"):
    """Patch both paths that would reach the network.

    Each is patched in the module that fetches, because the mount is
    built without touching either: the tree hydrates through
    ``ensure_tree`` / ``refill_index`` in ``core.github.tree``, and the
    default branch through ``ensure_default_branch`` in
    ``core.github.repo``.

    Args:
        tree (dict): The recursive tree to answer with.
        truncated (bool): Whether to report it truncated.
        default_branch (str): Branch the repo endpoint reports.
    """
    return (patch("mirage.core.github.repo.fetch_default_branch",
                  return_value=default_branch),
            patch("mirage.core.github.tree.fetch_tree",
                  return_value=(tree, truncated)))


def _make_vfs(ref: str = "main",
              default_branch: str | None = "main",
              tree: dict | None = None,
              truncated: bool = False) -> GitHubVFS:
    return GitHubVFS(
        config=CONFIG,
        owner=OWNER,
        repo=REPO,
        ref=ref,
        default_branch=default_branch,
        tree=tree,
        truncated=truncated,
    )


def test_name() -> None:
    vfs = _make_vfs()
    assert vfs.name == VFSName.GITHUB


def test_caches_reads() -> None:
    vfs = _make_vfs()
    assert vfs.caches_reads is True


def test_bind_args() -> None:
    vfs = _make_vfs()
    assert vfs.accessor.config is CONFIG
    assert vfs.accessor.owner == OWNER
    assert vfs.accessor.repo == REPO
    assert vfs.accessor.ref == "main"


def test_owner_repo_ref_fall_back_to_config() -> None:
    config = GitHubConfig(token="test-token",
                          owner="cfg-owner",
                          repo="cfg-repo",
                          ref="cfg-ref")
    vfs = GitHubVFS(config=config)
    assert vfs.accessor.owner == "cfg-owner"
    assert vfs.accessor.repo == "cfg-repo"
    assert vfs.accessor.ref == "cfg-ref"


def test_kwargs_take_precedence_over_config() -> None:
    config = GitHubConfig(token="test-token",
                          owner="cfg-owner",
                          repo="cfg-repo",
                          ref="cfg-ref")
    vfs = GitHubVFS(config=config,
                    owner="kw-owner",
                    repo="kw-repo",
                    ref="kw-ref")
    assert vfs.accessor.owner == "kw-owner"
    assert vfs.accessor.repo == "kw-repo"
    assert vfs.accessor.ref == "kw-ref"


def test_missing_owner_repo_raises() -> None:
    with pytest.raises(ValueError, match="requires owner and repo"):
        GitHubVFS(config=GitHubConfig(token="test-token"))


def test_is_default_branch_true() -> None:
    vfs = _make_vfs(ref="main", default_branch="main")
    assert vfs.is_default_branch is True


def test_is_default_branch_false() -> None:
    vfs = _make_vfs(ref="feature-branch", default_branch="main")
    assert vfs.is_default_branch is False


def test_is_default_branch_is_unknown_before_hydration() -> None:
    # None, not False: the branch is fetched on first use, and a bare
    # read hydrates only the tree, so False here would be a wrong answer
    # that could survive the life of the mount.
    vfs = _make_vfs(ref="main", default_branch=None)
    assert vfs.is_default_branch is None


@pytest.mark.asyncio
async def test_is_default_branch_answers_once_hydrated() -> None:
    vfs = _make_vfs(ref="main", default_branch=None)
    with patch("mirage.core.github.repo.fetch_default_branch",
               return_value="main"):
        await ensure_default_branch(vfs.accessor)
    assert vfs.is_default_branch is True


@pytest.mark.asyncio
async def test_stat_returns_sha_fingerprint() -> None:
    tree = {
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="abc123", size=100),
    }
    vfs = _make_vfs(tree=tree)
    with _offline(tree)[1]:
        result = await stat(vfs.accessor,
                            PathSpec.from_str_path("/src/main.py"), vfs.index)
    assert result.fingerprint == "abc123"


@pytest.mark.asyncio
async def test_replacing_index_still_serves_the_tree() -> None:
    tree = {
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="abc123", size=100),
    }
    vfs = _make_vfs(tree=tree)
    vfs.set_index(IndexConfig())

    # The fresh store is empty, which reads as not-live, so the next read
    # fills it by refetching rather than reporting the path gone.
    with _offline(tree)[1]:
        result = await stat(vfs.accessor,
                            PathSpec.from_str_path("/src/main.py"), vfs.index)
    assert result.fingerprint == "abc123"


@pytest.mark.asyncio
async def test_stat_raises_when_path_not_in_tree() -> None:
    vfs = _make_vfs()
    with _offline({})[1], pytest.raises(FileNotFoundError):
        await stat(vfs.accessor, PathSpec.from_str_path("/nonexistent.py"),
                   vfs.index)


def test_the_constructor_reaches_no_network() -> None:
    # The rule the lazy split exists to keep: naming a repository costs
    # nothing, so building a mount never blocks the caller's event loop
    # and build_vfs can stay synchronous.
    branch, fetch = _offline({})
    with branch as branch_m, fetch as fetch_m:
        vfs = GitHubVFS(CONFIG, OWNER, REPO, "main")
    branch_m.assert_not_called()
    fetch_m.assert_not_called()
    assert vfs.accessor.default_branch is None
    assert vfs.accessor.tree == {}


@pytest.mark.asyncio
async def test_ensure_default_branch_fetches_once_and_caches() -> None:
    vfs = _make_vfs(default_branch=None)
    with patch("mirage.core.github.repo.fetch_default_branch",
               return_value="develop") as mock_branch:
        assert await ensure_default_branch(vfs.accessor) == "develop"
        assert await ensure_default_branch(vfs.accessor) == "develop"
    assert vfs.accessor.default_branch == "develop"
    mock_branch.assert_awaited_once_with(CONFIG, OWNER, REPO,
                                         vfs.accessor.pool)


@pytest.mark.asyncio
async def test_ensure_tree_fetches_once_and_caches() -> None:
    tree = {
        "src/main.py":
        TreeEntry(path="src/main.py", type="blob", sha="abc123", size=100),
    }
    vfs = _make_vfs()
    with patch("mirage.core.github.tree.fetch_tree",
               return_value=(tree, False)) as mock_tree:
        await ensure_tree(vfs.accessor)
        await ensure_tree(vfs.accessor)
    assert vfs.accessor.tree == tree
    assert mock_tree.await_count == 1


@pytest.mark.asyncio
async def test_concurrent_ensure_tree_fetches_once() -> None:
    # The lock is the whole reason a first `find` and a first `du` racing
    # on a cold mount cost one tree fetch rather than two.
    vfs = _make_vfs()
    with patch("mirage.core.github.tree.fetch_tree",
               return_value=({}, False)) as mock_tree:
        mock_tree.return_value = ({
            "a.py":
            TreeEntry(path="a.py", type="blob", sha="s", size=1),
        }, False)
        await asyncio.gather(*(ensure_tree(vfs.accessor) for _ in range(8)))
    assert mock_tree.await_count == 1
