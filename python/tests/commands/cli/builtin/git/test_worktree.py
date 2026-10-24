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

from pathlib import Path

import pytest

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.worktree import (
    UNTRACKED_ALL,
    UNTRACKED_NO,
    UNTRACKED_NORMAL,
    scan,
    tracked_directories,
)
from mirage.types import LINK_TARGET_KEY, FileType, MountMode
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

from .conftest import LOCATION, MOUNT

TRACKED = {"a.txt", "b.txt"}


async def walk(ws, tracked: set[str], mode: str = UNTRACKED_NORMAL):
    """Scan the mounted working tree.

    Args:
        ws (Workspace): workspace with the repository mounted.
        tracked (set[str]): paths to treat as held by the index.
        mode (str): which untracked files to report.
    """
    return await scan(ws.vfs, LOCATION, tracked, mode)


def test_a_path_contributes_every_directory_above_it():
    assert tracked_directories({"a/b/c.txt"}) == {"a", "a/b"}


def test_a_root_level_path_contributes_no_directory():
    assert tracked_directories({"a.txt"}) == set()


@pytest.mark.asyncio
async def test_the_git_directory_is_never_walked(workspace):
    found = await walk(workspace, TRACKED)
    assert not any(path.startswith(".git") for path in found.files)
    assert not any(path.startswith(".git") for path in found.untracked)


@pytest.mark.asyncio
async def test_tracked_files_come_back_with_their_stat(workspace):
    found = await walk(workspace, TRACKED)
    assert found.files["a.txt"].size == len("one changed\n")


@pytest.mark.asyncio
async def test_a_file_the_index_does_not_hold_is_untracked(
    workspace, repo_path: Path
):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    found = await walk(workspace, TRACKED)
    assert found.untracked == ["fresh.txt"]


@pytest.mark.asyncio
async def test_an_untracked_directory_is_named_once(
    workspace, repo_path: Path
):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "one.txt").write_text("x\n", encoding="utf-8")
    (repo_path / "sub" / "two.txt").write_text("y\n", encoding="utf-8")
    found = await walk(workspace, TRACKED)
    assert found.untracked == ["sub/"]


@pytest.mark.asyncio
async def test_untracked_all_descends_instead(workspace, repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "one.txt").write_text("x\n", encoding="utf-8")
    found = await walk(workspace, TRACKED, UNTRACKED_ALL)
    assert found.untracked == ["sub/one.txt"]


@pytest.mark.asyncio
async def test_untracked_no_reports_none_of_them(workspace, repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "one.txt").write_text("x\n", encoding="utf-8")
    found = await walk(workspace, TRACKED, UNTRACKED_NO)
    assert found.untracked == []


@pytest.mark.asyncio
async def test_a_directory_holding_a_tracked_file_is_descended_into(
    workspace, repo_path: Path
):
    (repo_path / "src").mkdir()
    (repo_path / "src" / "tracked.txt").write_text("t\n", encoding="utf-8")
    (repo_path / "src" / "loose.txt").write_text("l\n", encoding="utf-8")
    found = await walk(workspace, TRACKED | {"src/tracked.txt"})
    assert found.untracked == ["src/loose.txt"]


@pytest.mark.asyncio
async def test_an_empty_directory_is_invisible(workspace, repo_path: Path):
    # git tracks no directories, so one holding nothing has nothing to
    # report and is not mentioned at all.
    (repo_path / "hollow").mkdir()
    found = await walk(workspace, TRACKED)
    assert found.untracked == []


@pytest.mark.asyncio
async def test_a_directory_of_only_ignored_files_is_invisible_too(
    workspace, repo_path: Path
):
    (repo_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    (repo_path / "logs").mkdir()
    (repo_path / "logs" / "a.log").write_text("x\n", encoding="utf-8")
    found = await walk(workspace, TRACKED)
    assert found.untracked == [".gitignore"]


@pytest.mark.asyncio
async def test_an_ignored_directory_holding_a_tracked_file_is_still_walked(
    workspace, repo_path: Path
):
    # Ignore rules govern untracked files only. Skipping the directory
    # would leave the tracked file unfound and reported as deleted.
    (repo_path / ".gitignore").write_text("vendor/\n", encoding="utf-8")
    (repo_path / "vendor").mkdir()
    (repo_path / "vendor" / "kept.txt").write_text("v\n", encoding="utf-8")
    (repo_path / "vendor" / "junk.txt").write_text("j\n", encoding="utf-8")
    found = await walk(workspace, TRACKED | {"vendor/kept.txt"})
    assert "vendor/kept.txt" in found.files
    assert "vendor/junk.txt" not in found.untracked


@pytest.mark.asyncio
async def test_a_symlink_is_reported_as_a_symlink(git_rw):
    # Links are namespace state, so the backend stat behind the walk
    # dereferences one: without the name plane the walk sees the target.
    await git_rw.shell("ln -s a.txt /repo/link")
    found = await walk(git_rw, TRACKED)
    assert found.files["link"].type is FileType.SYMLINK
    assert found.files["link"].extra[LINK_TARGET_KEY] == "a.txt"
    assert "link" in found.untracked


@pytest.mark.asyncio
async def test_a_broken_symlink_is_still_found(git_rw):
    # git lstats, so a link to nothing is an untracked entry like any
    # other; a dereferencing stat answers None and loses it entirely.
    await git_rw.shell("ln -s nowhere /repo/broken")
    found = await walk(git_rw, TRACKED)
    assert found.files["broken"].type is FileType.SYMLINK
    assert "broken" in found.untracked


@pytest.mark.asyncio
async def test_a_symlink_to_a_directory_is_not_descended(
    git_rw, repo_path: Path
):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "in.txt").write_text("x\n", encoding="utf-8")
    await git_rw.shell("ln -s sub /repo/dirlink")
    found = await walk(git_rw, TRACKED)
    assert found.files["dirlink"].type is FileType.SYMLINK
    assert not any(path.startswith("dirlink/") for path in found.files)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, limit, refused",
    [
        ("status", 2, True),
        ("add -A", 2, True),
        ("diff", 1, True),
        ("reset", 1, True),
        ("add sub", 2, True),
        ("add sub/x.txt", 2, False),
        ("add 'sub/[id].tsx'", 2, False),
        ("diff -- a.txt", 1, False),
        ("rm -q --cached b.txt", 1, False),
    ],
)
async def test_a_work_tree_past_the_walk_limit_fails_unless_named(
    repo_path: Path, line: str, limit: int, refused: bool
):
    (repo_path / "sub").mkdir()
    for name in ("x.txt", "y.txt", "[id].tsx"):
        (repo_path / "sub" / name).write_text("x\n", encoding="utf-8")
    index = (repo_path / ".git" / "index").read_bytes()
    with Workspace(
        {MOUNT: DiskVFS(root=str(repo_path), walk_limit=limit)},
        mode=MountMode.WRITE,
    ) as ws:
        ws.register_cli("git", GIT)
        result = await ws.shell(f"git -C /repo {line} >/dev/null; echo $?")
        outcome = (await result.stdout_str(), await result.stderr_str())
    if refused:
        assert outcome == (
            "128\n",
            f"fatal: more than {limit} files in the work tree (walk_limit)\n",
        )
        assert (repo_path / ".git" / "index").read_bytes() == index
    else:
        assert outcome == ("0\n", "")


class TreeRAM(RAMVFS):
    """A RAM work tree held to ten files, noting each subtree read and
    the limit it was handed."""

    def __init__(self, *dirs: str) -> None:
        super().__init__(walk_limit=10)
        self.trees: list[tuple[str, int | None]] = []
        self._store.dirs.update({"/.git", *dirs})

    async def read_tree(self, path, limit=None):
        self.trees.append((path.virtual, limit))
        return await super().read_tree(path)


@pytest.mark.asyncio
async def test_a_first_file_probe_lists_rather_than_reading_a_subtree():
    vfs = TreeRAM("/new", "/new/deep")
    vfs._store.files["/new/deep/b.txt"] = b"b\n"
    with Workspace({MOUNT: vfs}) as ws:
        found = await walk(ws, set())
    assert (found.untracked, vfs.trees) == (["new/"], [])


@pytest.mark.asyncio
async def test_a_full_walk_hands_a_subtree_read_what_it_may_still_count():
    vfs = TreeRAM("/new")
    vfs._store.files.update({"/a.txt": b"a\n", "/new/b.txt": b"b\n"})
    with Workspace({MOUNT: vfs}) as ws:
        found = await walk(ws, set(), UNTRACKED_ALL)
    assert found.untracked == ["a.txt", "new/b.txt"]
    assert vfs.trees == [("/repo/new", 10)]
