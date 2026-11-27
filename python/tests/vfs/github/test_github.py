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
from tests.core.github.conftest import (
    TREES,
    UNTIL_CLEARED,
    GitHubRepo,
    blob_sha,
)

CONFIG = GitHubConfig(token="test-token")
OWNER = "test-owner"
REPO = "test-repo"
# The tree git names an empty folder by.
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"


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


def _on(repo: GitHubRepo, default_branch: str | None = "main") -> GitHubVFS:
    return GitHubVFS(
        config=repo.config(),
        ref="main",
        default_branch=default_branch,
    )


def test_name() -> None:
    vfs = _make_vfs()
    assert vfs.name == VFSName.GITHUB


def test_caches_reads() -> None:
    vfs = _make_vfs()
    assert vfs.caches_reads is True


def test_bind_args() -> None:
    vfs = _make_vfs()
    assert vfs.config is CONFIG
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

    saved = vfs.get_state()["config"]
    assert (saved["owner"], saved["repo"], saved["ref"]) == (
        "kw-owner",
        "kw-repo",
        "kw-ref",
    )
    assert config.owner == "cfg-owner"


def test_missing_owner_repo_raises() -> None:
    with pytest.raises(ValueError, match="requires owner and repo"):
        GitHubVFS(config=GitHubConfig(token="test-token"))


async def _stat_at(vfs: GitHubVFS, path: str) -> FileStat:
    ws = Workspace({"/gh": vfs}, mode=MountMode.READ)
    try:
        row, _ = await ws.dispatch("stat", PathSpec.from_str_path(path))
        return row
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_stat_returns_sha_fingerprint(repo) -> None:
    await repo.create({"src/main.py": b"m" * 100})
    result = await _stat_at(_on(repo), "/gh/src/main.py")
    assert result.fingerprint == blob_sha(b"m" * 100)


@pytest.mark.asyncio
async def test_a_check_store_asks_the_parent_directory(repo) -> None:
    await repo.create({"src/main.py": b"m" * 100})
    vfs = _on(repo)

    # A check's private store holds no listing and is handed no row, so
    # the stat asks the parent directory rather than reporting the path
    # gone.
    result = await stat(
        vfs.accessor,
        PathSpec.from_str_path("/src/main.py"),
        None,
        ListingCheckStore(),
    )
    assert result.fingerprint == blob_sha(b"m" * 100)
    assert await repo.log() == [("dir", "main:src")]


@pytest.mark.asyncio
async def test_stat_raises_when_path_not_in_tree(repo) -> None:
    await repo.create({"top.txt": b"t"})
    with pytest.raises(FileNotFoundError):
        await _stat_at(_on(repo), "/gh/nonexistent.py")


@pytest.mark.asyncio
async def test_the_constructor_reaches_no_network(repo) -> None:
    # The rule the lazy split exists to keep: naming a repository costs
    # nothing, so building a mount never blocks the caller's event loop
    # and build_vfs can stay synchronous.
    await repo.create({"top.txt": b"t"})
    vfs = GitHubVFS(repo.config(), ref="main")
    assert await repo.log() == []
    assert vfs.accessor.default_branch is None
    assert vfs.accessor.tree == {}


@pytest.mark.asyncio
async def test_ensure_default_branch_fetches_once_and_caches(repo) -> None:
    await repo.create({"top.txt": b"t"})
    await repo.branch("develop")
    await repo.set_default_branch("develop")
    vfs = _on(repo, default_branch=None)
    assert await ensure_default_branch(vfs.accessor) == "develop"
    assert await ensure_default_branch(vfs.accessor) == "develop"
    assert vfs.accessor.default_branch == "develop"
    assert await repo.log() == [("repo", "")]


@pytest.mark.asyncio
async def test_ensure_tree_fetches_once_and_caches(repo) -> None:
    await repo.create({"src/main.py": b"m" * 100})
    vfs = _on(repo)
    await ensure_tree(vfs.accessor)
    await ensure_tree(vfs.accessor)
    assert vfs.accessor.tree["src/main.py"] == TreeEntry(
        path="src/main.py", type="blob", sha=blob_sha(b"m" * 100), size=100
    )
    assert await repo.count("recursive") == 1


@pytest.mark.asyncio
async def test_concurrent_ensure_tree_fetches_once(repo) -> None:
    # The lock is the whole reason a first `find` and a first `du` racing
    # on a cold mount cost one tree fetch rather than two.
    await repo.create({"a.py": b"a"})
    vfs = _on(repo)
    await asyncio.gather(*(ensure_tree(vfs.accessor) for _ in range(8)))
    assert await repo.count("recursive") == 1


async def _with_an_empty_folder(repo: GitHubRepo, name: str) -> None:
    # GitHub holds an empty folder as an empty tree written through the git
    # database; the fake's trees hold files only, so its answers carry the
    # folder's row, and the folder lists as empty.
    row = {"path": name, "mode": "040000", "type": "tree", "sha": EMPTY_TREE}
    whole = await repo.tree("main", recursive=True)
    root = await repo.tree("main")
    empty = {"sha": EMPTY_TREE, "tree": [], "truncated": False}
    answers = [
        ("recursive=1", repo.tree_path("main"), whole),
        ("", repo.tree_path("main"), root),
        ("", repo.tree_path("main:"), root),
    ]
    for query, path, listing in answers:
        grown = {**listing, "tree": [*listing["tree"], row]}
        await repo.run.answer_next(
            "GET", TREES, 200, grown, UNTIL_CLEARED, path, query
        )
    for segment in (EMPTY_TREE, f"main:{name}"):
        await repo.run.answer_next(
            "GET", TREES, 200, empty, UNTIL_CLEARED, repo.tree_path(segment)
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mode,refusal",
    [
        (MountMode.READ, "Read-only file system"),
        (MountMode.WRITE, "Operation not supported"),
    ],
)
async def test_removing_a_tree_entry_is_refused_not_missing(
    repo, mode: MountMode, refusal: str
) -> None:
    # Cold stats and warmed listings must agree on existence, so removal
    # reports the mount's refusal rather than ENOENT, including with -f.
    await repo.create({"top.txt": b"to"})
    await _with_an_empty_folder(repo, "empty")
    ws = Workspace({"/gh": _on(repo)}, mode=mode)
    try:
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
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_find_judges_a_directory_by_what_the_session_sees(repo) -> None:
    # A walk asks read_tree, which the dispatcher declines under a hide,
    # so -empty sees the directory as the session does.
    await repo.create({"docs/guide.md": b"gui", "top.txt": b"to"})
    ws = Workspace({"/gh": _on(repo)}, mode=MountMode.READ)
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
