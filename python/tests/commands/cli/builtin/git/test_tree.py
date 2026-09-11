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

from mirage import Workspace
from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.specs import cli_spec_for
from mirage.resource.ram import RAMResource
from mirage.types import MountMode

HEAD_MAIN = b"ref: refs/heads/main\n"
NOT_A_REPO = (b"fatal: not a git repository (or any of the parent "
              b"directories): .git\n")
# These repositories are a bare HEAD file and nothing else, which is
# what discovery needs and all these tests are about. Status still
# renders the whole report for one, and it is the report git gives a
# repository with no commits in it.
NOTHING_YET = (b'\n\nNo commits yet\n\nnothing to commit (create/copy files '
               b'and use "git add" to track)\n')
ON_MAIN = b"On branch main" + NOTHING_YET


def leaf(name: str):
    """Resolve one verb of the git tree.

    Args:
        name (str): the verb's name.
    """
    return next(c for c in GIT.subcommands if c.name == name)


def test_tree_shape():
    assert GIT.name == "git"
    assert [v.name for v in GIT.subcommands] == [
        "status", "log", "show", "diff", "branch", "add", "reset", "commit",
        "checkout"
    ]


def test_git_needs_no_credentials():
    # Tier 3: a credential-free nested CLI, installable with a bare
    # `cli: git` and no config block.
    assert GIT.config_model is None


def test_resolvable_by_name_from_yaml():
    assert cli_spec_for("git") is GIT


def test_directory_option_is_a_path_defaulting_to_cwd():
    option = next(o for o in GIT.options if o.short == "-C")
    assert option.type == "path"
    # The default is load-bearing: a PATH default lands as if typed, so
    # an absent -C resolves to the session cwd and no leaf needs a
    # separate working-directory fact.
    assert option.default == "."


def test_status_only_reads():
    assert not leaf("status").write


@pytest.mark.asyncio
async def test_status_outside_a_repository_is_gits_fatal():
    with Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        result = await ws.execute("git -C /data status")
    assert result.exit_code == 128
    assert result.stderr == NOT_A_REPO


@pytest.mark.asyncio
async def test_status_reports_the_checked_out_branch():
    with Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("mkdir -p /data/repo/.git")
        await ws.fs.write("/data/repo/.git/HEAD", HEAD_MAIN)
        result = await ws.execute("git -C /data/repo status")
    assert result.exit_code == 0
    assert result.stdout == ON_MAIN


@pytest.mark.asyncio
async def test_discovery_walks_up_from_a_subdirectory():
    with Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("mkdir -p /data/repo/.git")
        await ws.execute("mkdir -p /data/repo/src/deep")
        await ws.fs.write("/data/repo/.git/HEAD", HEAD_MAIN)
        result = await ws.execute("git -C /data/repo/src/deep status")
    assert result.exit_code == 0
    assert result.stdout == ON_MAIN


@pytest.mark.asyncio
async def test_discovery_stops_at_the_mount_root():
    # The .git sits above the mount, on another backend entirely, so
    # git's filesystem-boundary rule must not reach it.
    with Workspace({
            "/": RAMResource(),
            "/data/": RAMResource(),
    },
                   mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("mkdir -p /.git")
        await ws.fs.write("/.git/HEAD", HEAD_MAIN)
        await ws.execute("mkdir -p /data/work")
        result = await ws.execute("git -C /data/work status")
    assert result.exit_code == 128
    assert result.stderr == NOT_A_REPO


@pytest.mark.asyncio
async def test_detached_head_reports_the_short_commit():
    with Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("mkdir -p /data/repo/.git")
        await ws.fs.write("/data/repo/.git/HEAD",
                          b"cdd6234342b147880f5d86c55dad6c1fbe222bfe\n")
        result = await ws.execute("git -C /data/repo status")
    assert result.exit_code == 0
    assert result.stdout == b"HEAD detached at cdd6234" + NOTHING_YET


@pytest.mark.asyncio
async def test_bare_status_uses_the_session_cwd():
    with Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("mkdir -p /data/repo/.git")
        await ws.fs.write("/data/repo/.git/HEAD", HEAD_MAIN)
        result = await ws.execute("cd /data/repo && git status")
    assert result.exit_code == 0
    assert result.stdout == ON_MAIN
