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
from dulwich.object_store import MemoryObjectStore
from dulwich.objects import Blob, Tree

from mirage import Workspace
from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.tree import tree_entries
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.spec.compile import compile_spec
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS

HEAD_MAIN = b"ref: refs/heads/main\n"
NOT_A_REPO = (
    b"fatal: not a git repository (or any of the parent directories): .git\n"
)
# These repositories are a bare HEAD file and nothing else, which is
# what discovery needs and all these tests are about. Status still
# renders the whole report for one, and it is the report git gives a
# repository with no commits in it.
NOTHING_YET = (
    b"\n\nNo commits yet\n\nnothing to commit (create/copy files "
    b'and use "git add" to track)\n'
)
ON_MAIN = b"On branch main" + NOTHING_YET


def leaf(name: str):
    """Resolve one verb of the git tree.

    Args:
        name (str): the verb's name.
    """
    return next(c for c in GIT.spec.subcommands if c.name == name)


def test_tree_shape():
    assert GIT.spec.name == "git"
    assert [v.name for v in GIT.spec.subcommands] == [
        "reflog",
        "for-each-ref",
        "cat-file",
        "hash-object",
        "grep",
        "ls-tree",
        "ls-files",
        "fetch",
        "clone",
        "help",
        "init",
        "fsck",
        "stash",
        "version",
        "remote",
        "config",
        "show-ref",
        "symbolic-ref",
        "shortlog",
        "rev-parse",
        "rev-list",
        "diff-tree",
        "status",
        "log",
        "show",
        "diff",
        "branch",
        "add",
        "reset",
        "commit",
        "checkout",
        "switch",
        "restore",
        "rm",
        "mv",
        "tag",
    ]


def test_git_needs_no_credentials():
    # Tier 3: a credential-free nested CLI, installable with a bare
    # `cli: git` and no config block.
    assert GIT.config_model is None


def test_resolvable_by_name_from_yaml():
    assert cli_spec_for("git") is GIT


def test_directory_option_is_a_path_defaulting_to_cwd():
    option = next(o for o in compile_spec(GIT.spec).options if "-C" in o.names)
    assert option.type == "path"
    # The default is load-bearing: a PATH default lands as if typed, so
    # an absent -C resolves to the session cwd and no leaf needs a
    # separate working-directory fact.
    assert option.default == "."


def test_status_only_reads():
    assert not GIT.handlers["status"].write


@pytest.mark.asyncio
async def test_status_outside_a_repository_is_gits_fatal():
    with Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        result = await ws.shell("git -C /data status")
    assert result.exit_code == 128
    assert result.stderr == NOT_A_REPO


@pytest.mark.asyncio
async def test_status_reports_the_checked_out_branch():
    with Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir -p /data/repo/.git")
        await ws.vfs.write("/data/repo/.git/HEAD", HEAD_MAIN)
        result = await ws.shell("git -C /data/repo status")
    assert result.exit_code == 0
    assert result.stdout == ON_MAIN


@pytest.mark.asyncio
async def test_discovery_walks_up_from_a_subdirectory():
    with Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir -p /data/repo/.git")
        await ws.shell("mkdir -p /data/repo/src/deep")
        await ws.vfs.write("/data/repo/.git/HEAD", HEAD_MAIN)
        result = await ws.shell("git -C /data/repo/src/deep status")
    assert result.exit_code == 0
    assert result.stdout == ON_MAIN


@pytest.mark.asyncio
async def test_discovery_stops_at_the_mount_root():
    # The .git sits above the mount, on another backend entirely, so
    # git's filesystem-boundary rule must not reach it.
    with Workspace(
        {
            "/": RAMVFS(),
            "/data/": RAMVFS(),
        },
        mode=MountMode.WRITE,
    ) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir -p /.git")
        await ws.vfs.write("/.git/HEAD", HEAD_MAIN)
        await ws.shell("mkdir -p /data/work")
        result = await ws.shell("git -C /data/work status")
    assert result.exit_code == 128
    assert result.stderr == NOT_A_REPO


@pytest.mark.asyncio
async def test_a_detached_head_no_checkout_moved_is_on_no_branch():
    with Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir -p /data/repo/.git")
        await ws.vfs.write(
            "/data/repo/.git/HEAD",
            b"cdd6234342b147880f5d86c55dad6c1fbe222bfe\n",
        )
        result = await ws.shell("git -C /data/repo status")
    assert result.exit_code == 0
    assert result.stdout == b"Not currently on any branch." + NOTHING_YET


@pytest.mark.asyncio
async def test_bare_status_uses_the_session_cwd():
    with Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir -p /data/repo/.git")
        await ws.vfs.write("/data/repo/.git/HEAD", HEAD_MAIN)
        result = await ws.shell("cd /data/repo && git status")
    assert result.exit_code == 0
    assert result.stdout == ON_MAIN


def test_tree_entries_flattens_subtrees_and_keeps_a_submodule_whole():
    blob = Blob.from_string(b"x\n")
    commit = b"1" * 40
    sub = Tree()
    sub.add(b"b.txt", 0o100644, blob.id)
    root = Tree()
    root.add(b"a.txt", 0o100755, blob.id)
    root.add(b"dir", 0o040000, sub.id)
    root.add(b"vendor", 0o160000, commit)
    store = MemoryObjectStore()
    for obj in (blob, sub, root):
        store.add_object(obj)
    assert tree_entries(store, root.id) == {
        b"a.txt": (0o100755, blob.id),
        b"dir/b.txt": (0o100644, blob.id),
        b"vendor": (0o160000, commit),
    }
