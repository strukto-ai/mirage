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
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

import pytest

from mirage.cache.index.ram import ListingCheckStore
from mirage.core.github.config import GitHubConfig
from mirage.core.github.repo import ensure_default_branch
from mirage.core.github.stat import stat
from mirage.core.github.tree import ensure_tree
from mirage.core.github.tree_entry import TreeEntry
from mirage.types import (
    FileStat,
    HiddenPaths,
    MountMode,
    PathSpec,
    VFSName,
    Visibility,
)
from mirage.vfs.github.github import GitHubVFS
from mirage.workspace import Workspace

CONFIG = GitHubConfig(token="test-token")
OWNER = "test-owner"
REPO = "test-repo"


@pytest.fixture(autouse=True)
def no_network() -> Iterator[None]:
    with patch(
        "mirage.core.github.client.api_request",
        side_effect=AssertionError("unexpected GitHub network request"),
    ) as request:
        yield
        request.assert_not_called()


@contextmanager
def _offline(
    tree: dict, truncated: bool = False, default_branch: str = "main"
) -> Iterator[tuple[AsyncMock, AsyncMock]]:
    """Patch branch discovery, recursive trees, and directory lookups together.

    Args:
        tree (dict): The recursive tree to answer with.
        truncated (bool): Whether to report it truncated.
        default_branch (str): Branch the repo endpoint reports.
    """
    with (
        patch(
            "mirage.core.github.repo.fetch_default_branch",
            return_value=default_branch,
        ) as branch,
        patch(
            "mirage.core.github.tree.fetch_tree",
            return_value=(tree, truncated, None),
        ) as fetch,
        _listing(tree),
    ):
        yield branch, fetch


def _listing(tree: dict):
    """Patch the one-directory listing a stat asks an empty index for.

    Args:
        tree (dict): The recursive tree each listing is cut from.
    """

    async def page(config, owner, repo, tree_sha, session=None):
        at = tree_sha.partition(":")[2]
        stem = at + "/" if at else ""
        return [
            TreeEntry(
                path=path[len(stem) :],
                type=entry.type,
                sha=entry.sha,
                size=entry.size,
            )
            for path, entry in tree.items()
            if path.startswith(stem) and "/" not in path[len(stem) :]
        ], False

    return patch("mirage.core.github.tree.fetch_dir_page", new=page)


def _make_vfs(
    ref: str = "main",
    default_branch: str | None = "main",
    tree: dict | None = None,
    truncated: bool = False,
) -> GitHubVFS:
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
    config = GitHubConfig(
        token="test-token", owner="cfg-owner", repo="cfg-repo", ref="cfg-ref"
    )
    vfs = GitHubVFS(config=config)
    assert vfs.accessor.owner == "cfg-owner"
    assert vfs.accessor.repo == "cfg-repo"
    assert vfs.accessor.ref == "cfg-ref"


def test_kwargs_take_precedence_over_config() -> None:
    config = GitHubConfig(
        token="test-token", owner="cfg-owner", repo="cfg-repo", ref="cfg-ref"
    )
    vfs = GitHubVFS(
        config=config, owner="kw-owner", repo="kw-repo", ref="kw-ref"
    )
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
    with patch(
        "mirage.core.github.repo.fetch_default_branch", return_value="main"
    ):
        await ensure_default_branch(vfs.accessor)
    assert vfs.is_default_branch is True


async def _stat_at(vfs: GitHubVFS, path: str) -> FileStat:
    ws = Workspace({"/gh": vfs}, mode=MountMode.READ)
    try:
        row, _ = await ws.dispatch("stat", PathSpec.from_str_path(path))
        return row
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_stat_returns_sha_fingerprint() -> None:
    tree = {
        "src/main.py": TreeEntry(
            path="src/main.py", type="blob", sha="abc123", size=100
        ),
    }
    with _offline(tree):
        result = await _stat_at(_make_vfs(tree=tree), "/gh/src/main.py")
    assert result.fingerprint == "abc123"


@pytest.mark.asyncio
async def test_a_check_store_asks_the_parent_directory() -> None:
    tree = {
        "src/main.py": TreeEntry(
            path="src/main.py", type="blob", sha="abc123", size=100
        ),
    }
    vfs = _make_vfs(tree=tree)

    # A check's private store holds no listing and is handed no row, so
    # the stat asks the parent directory rather than reporting the path
    # gone.
    with _offline(tree):
        result = await stat(
            vfs.accessor,
            PathSpec.from_str_path("/src/main.py"),
            None,
            ListingCheckStore(),
        )
    assert result.fingerprint == "abc123"


@pytest.mark.asyncio
async def test_stat_raises_when_path_not_in_tree() -> None:
    with _offline({}), pytest.raises(FileNotFoundError):
        await _stat_at(_make_vfs(), "/gh/nonexistent.py")


def test_the_constructor_reaches_no_network() -> None:
    # The rule the lazy split exists to keep: naming a repository costs
    # nothing, so building a mount never blocks the caller's event loop
    # and build_vfs can stay synchronous.
    with _offline({}) as (branch_m, fetch_m):
        vfs = GitHubVFS(CONFIG, OWNER, REPO, "main")
    branch_m.assert_not_called()
    fetch_m.assert_not_called()
    assert vfs.accessor.default_branch is None
    assert vfs.accessor.tree == {}


@pytest.mark.asyncio
async def test_ensure_default_branch_fetches_once_and_caches() -> None:
    vfs = _make_vfs(default_branch=None)
    with patch(
        "mirage.core.github.repo.fetch_default_branch", return_value="develop"
    ) as mock_branch:
        assert await ensure_default_branch(vfs.accessor) == "develop"
        assert await ensure_default_branch(vfs.accessor) == "develop"
    assert vfs.accessor.default_branch == "develop"
    mock_branch.assert_awaited_once_with(
        CONFIG, OWNER, REPO, vfs.accessor.pool
    )


@pytest.mark.asyncio
async def test_ensure_tree_fetches_once_and_caches() -> None:
    tree = {
        "src/main.py": TreeEntry(
            path="src/main.py", type="blob", sha="abc123", size=100
        ),
    }
    vfs = _make_vfs()
    with patch(
        "mirage.core.github.tree.fetch_tree", return_value=(tree, False, None)
    ) as mock_tree:
        await ensure_tree(vfs.accessor)
        await ensure_tree(vfs.accessor)
    assert vfs.accessor.tree == tree
    assert mock_tree.await_count == 1


@pytest.mark.asyncio
async def test_concurrent_ensure_tree_fetches_once() -> None:
    # The lock is the whole reason a first `find` and a first `du` racing
    # on a cold mount cost one tree fetch rather than two.
    vfs = _make_vfs()
    with patch(
        "mirage.core.github.tree.fetch_tree", return_value=({}, False, None)
    ) as mock_tree:
        mock_tree.return_value = (
            {
                "a.py": TreeEntry(path="a.py", type="blob", sha="s", size=1),
            },
            False,
            None,
        )
        await asyncio.gather(*(ensure_tree(vfs.accessor) for _ in range(8)))
    assert mock_tree.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,refusal",
    [
        (MountMode.READ, "Read-only file system"),
        (MountMode.WRITE, "Operation not supported"),
    ],
)
async def test_removing_a_tree_entry_is_refused_not_missing(
    mode: MountMode, refusal: str
) -> None:
    # Cold stats and warmed listings must agree on existence, so removal
    # reports the mount's refusal rather than ENOENT, including with -f.
    tree = {
        "top.txt": TreeEntry(path="top.txt", type="blob", sha="a", size=2),
        "empty": TreeEntry(path="empty", type="tree", sha="b", size=None),
    }
    with _offline(tree):
        ws = Workspace({"/gh": _make_vfs()}, mode=mode)
        lines = {
            "rm /gh/top.txt": f"rm: cannot remove '/gh/top.txt': {refusal}\n",
            "rm -f /gh/top.txt": f"rm: cannot remove '/gh/top.txt': {refusal}\n",
            "rmdir /gh/empty": f"rmdir: failed to remove '/gh/empty': {refusal}\n",
            "unlink /gh/top.txt": f"unlink: cannot unlink '/gh/top.txt': {refusal}\n",
            "rm /gh/nope": "rm: cannot remove '/gh/nope': No such file or directory\n",
        }
        for line, stderr in lines.items():
            result = await ws.shell(line)
            assert (result.exit_code, await result.stderr_str()) == (1, stderr)
        result = await ws.shell("rm -f /gh/nope")
        assert (result.exit_code, await result.stderr_str()) == (0, "")
        result = await ws.shell("ls /gh")
        assert await result.stdout_str() == "empty\ntop.txt\n"


@pytest.mark.asyncio
async def test_find_judges_a_directory_by_what_the_session_sees() -> None:
    # A walk asks read_tree, which the dispatcher declines under a hide,
    # so -empty sees the directory as the session does.
    tree = {
        "docs": TreeEntry(path="docs", type="tree", sha="d", size=None),
        "docs/guide.md": TreeEntry(
            path="docs/guide.md", type="blob", sha="g", size=3
        ),
        "top.txt": TreeEntry(path="top.txt", type="blob", sha="t", size=2),
    }
    with _offline(tree):
        ws = Workspace({"/gh": _make_vfs()}, mode=MountMode.READ)
        try:
            result = await ws.shell("find /gh; find /gh -type d -empty")
            assert await result.stdout_str() == (
                "/gh\n/gh/docs\n/gh/docs/guide.md\n/gh/top.txt\n"
            )
            session = ws.create_session("veiled")
            session.visibility = Visibility(
                paths=HiddenPaths(paths=("/gh/docs/guide.md",))
            )
            result = await ws.shell(
                "find /gh; find /gh -type d -empty", session_id="veiled"
            )
            assert await result.stdout_str() == (
                "/gh\n/gh/docs\n/gh/top.txt\n/gh/docs\n"
            )
        finally:
            await ws.close()
