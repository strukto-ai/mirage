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

from dataclasses import replace

import pytest
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.errors import (
    NoWorkingDirectoryError,
    NoWorkspaceError,
)
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.types import CLIDoors
from mirage.commands.spec.flag_view import FlagView
from mirage.types import MountMode, PathSpec
from mirage.vfs.disk import DiskVFS
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.commands.cli.builtin.git.conftest import repo_doors


@pytest.mark.asyncio
async def test_no_workspace_behind_the_cli_is_a_fatal():
    # Only reachable when a leaf is called directly: inside a workspace
    # the dispatcher always offers the facts a leaf declares.
    with pytest.raises(NoWorkspaceError):
        await opened(
            FlagView({"C": PathSpec.from_str_path("/repo")}), CLIDoors()
        )


@pytest.mark.asyncio
async def test_a_missing_plane_is_enough_to_fail(workspace):
    # The name plane carries the mount root discovery stops at, so a
    # record without it cannot open a repository even with the other
    # two doors wired.
    doors = replace(repo_doors(workspace), ns=None)
    with pytest.raises(NoWorkspaceError):
        await opened(FlagView({"C": PathSpec.from_str_path("/repo")}), doors)


@pytest.mark.asyncio
async def test_opening_reports_both_the_gitdir_and_its_worktree(workspace):
    repo, location = await opened(
        FlagView({"C": PathSpec.from_str_path("/repo")}), repo_doors(workspace)
    )
    assert isinstance(repo, BaseRepo)
    assert location.gitdir.virtual == "/repo/.git"
    assert location.worktree.virtual == "/repo"


@pytest.mark.asyncio
async def test_every_verb_inherits_the_same_discovery_walk(workspace):
    _repo, location = await opened(
        FlagView({"C": PathSpec.from_str_path("/repo")}), repo_doors(workspace)
    )
    assert location.mount_root.virtual == "/repo"


@pytest.mark.asyncio
async def test_a_directory_that_is_not_there_is_gits_chdir_fatal(workspace):
    # The mount root at /repo is itself a repository, so a path inside it
    # always discovers one; what is left to reach from here is the other
    # fatal. Giving up at the mount root is covered in test_discover.
    with pytest.raises(NoWorkingDirectoryError) as excinfo:
        await opened(
            FlagView({"C": PathSpec.from_str_path("/nowhere")}),
            repo_doors(workspace),
        )
    assert str(excinfo.value) == (
        "cannot change to '/nowhere': No such file or directory"
    )


@pytest.mark.asyncio
async def test_a_read_only_work_tree_keeps_its_own_error(repo_path, tmp_path):
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "a.txt").write_text("one changed\n")
    mounts = {
        "/repo": DiskVFS(root=str(repo_path)),
        "/tree": Mount(vfs=DiskVFS(root=str(tree)), mode=MountMode.READ),
    }
    with Workspace(mounts, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        result = await ws.shell(
            "git --git-dir=/repo/.git --work-tree=/tree "
            "restore --source=HEAD~1 a.txt"
        )
    assert result.exit_code == 1, await result.stderr_str()
    assert b"/tree/" in result.stderr
    assert b"index.lock" not in result.stderr
