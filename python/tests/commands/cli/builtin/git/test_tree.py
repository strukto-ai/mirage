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
from dulwich.objects import Blob, Tree
from dulwich.repo import MemoryRepo

from mirage import Workspace
from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.constants import GITLINK, REGULAR, SYMLINK
from mirage.commands.cli.builtin.git.tree import tree_entries, valid_path
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.spec.compile import compile_spec
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from tests.commands.cli.builtin.git.conftest import branch_with_paths, run

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
EMPTY_NAMED = {
    "root": {"/x.txt": b"x\n", "a.txt": b"a\n"},
    "nested": {"sub//x.txt": b"x\n", "a.txt": b"a\n"},
}
EMPTY_NAME = b"fatal: empty filename in tree entry\n"


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
        "merge-base",
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


def test_every_verb_that_can_change_the_repository_is_a_write():
    # A verb that writes only under some of its options (branch,
    # symbolic-ref, hash-object -w) still counts, since policy and the
    # cache read one answer for the whole verb.
    assert {
        path for path, handler in GIT.handlers.items() if handler.write
    } == {
        "add",
        "branch",
        "checkout",
        "clone",
        "commit",
        "fetch",
        "hash-object",
        "init",
        "mv",
        "reset",
        "restore",
        "rm",
        "switch",
        "symbolic-ref",
        "tag",
    }


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
    repo = MemoryRepo()
    for obj in (blob, sub, root):
        repo.object_store.add_object(obj)
    assert tree_entries(repo, root.id) == {
        b"a.txt": (0o100755, blob.id),
        b"dir/b.txt": (0o100644, blob.id),
        b"vendor": (0o160000, commit),
    }


@pytest.mark.parametrize(
    "path,mode,expected",
    [
        ("a.txt", REGULAR, True),
        ("docs/readme.md", REGULAR, True),
        (".gitignore", REGULAR, True),
        ("a.git/x", REGULAR, True),
        ("sub/.gitx", REGULAR, True),
        ("..a/b", REGULAR, True),
        ("../a", REGULAR, False),
        ("a/..", REGULAR, False),
        ("./a", REGULAR, False),
        ("a/./b", REGULAR, False),
        ("a//b", REGULAR, False),
        ("", REGULAR, False),
        (".git", REGULAR, False),
        (".GIT/config", REGULAR, False),
        ("sub/.Git/hooks/x", REGULAR, False),
        (".git.", REGULAR, False),
        (".git /x", REGULAR, False),
        (".GIT. /x", REGULAR, False),
        ("git~1", REGULAR, False),
        ("GIT~1/x", REGULAR, False),
        ("git~1../x", REGULAR, False),
        (".git::$INDEX_ALLOCATION/x", REGULAR, False),
        (".git:x", REGULAR, False),
        (".git:\nx", REGULAR, False),
        ("git~1:x", REGULAR, False),
        (".git\\x", REGULAR, False),
        ("x\\.git/f", REGULAR, False),
        ("\\\\.git", REGULAR, False),
        (".git\\", REGULAR, False),
        ("\\.git", REGULAR, True),
        ("d/\\.git/y", REGULAR, True),
        ("\\GIT~1", REGULAR, True),
        ("\\.git\\x", REGULAR, True),
        ("sub/.git.", REGULAR, False),
        ("git~2/x", REGULAR, True),
        ("git~10", REGULAR, True),
        (".git.x", REGULAR, True),
        (".git~1", REGULAR, True),
        (" .git", REGULAR, True),
        ("x.git.", REGULAR, True),
        ("a\\b", REGULAR, True),
        ("..\\x", REGULAR, True),
        ("a\\..", REGULAR, True),
        (".g\u0131t", REGULAR, True),
        (".gitmodules", REGULAR, True),
        ("gitmod~1", REGULAR, True),
        (".gitmodules/b", REGULAR, True),
        (".gitmodules", SYMLINK, False),
        (".GITMODULES.", SYMLINK, False),
        (".gitmodules::$DATA", SYMLINK, False),
        ("sub/.gitmodules", SYMLINK, False),
        ("gitmod~4", SYMLINK, False),
        ("GI7EBA~9", SYMLINK, False),
        ("gi7eb~12", SYMLINK, False),
        ("g~123456", SYMLINK, False),
        ("~1234567", SYMLINK, False),
        ("GI7EB~12.", SYMLINK, False),
        ("x\\.gitmodules", SYMLINK, False),
        ("x\\\\gitmod~1", SYMLINK, False),
        (".gitmodules/b", SYMLINK, False),
        (".GITMODULES/b", SYMLINK, False),
        (".gitmodules:x/y", SYMLINK, False),
        ("a/.gitmodules/x", SYMLINK, False),
        ("gitmod~5", SYMLINK, True),
        ("gi7eba~10", SYMLINK, True),
        ("gi7eb~1", SYMLINK, True),
        ("gi7eb~123", SYMLINK, True),
        ("gi7eb~02", SYMLINK, True),
        ("gx7eb~12", SYMLINK, True),
        (".gitmodules.x", SYMLINK, True),
        (".gitattributes", SYMLINK, True),
        (".gitmodule\u017f", SYMLINK, True),
        (".gitmodules\\x", SYMLINK, True),
        ("\\.gitmodules", SYMLINK, True),
        ("\\gi7eb~12", SYMLINK, True),
        (".gitmodules./b", SYMLINK, True),
        ("gitmod~1/b", SYMLINK, True),
        ("x\\.gitmodules/b", SYMLINK, True),
        (".gitmodules", 0o120644, False),
        (".gitmodules", 0o120755, False),
        (".gitmodules", 0o100755, True),
        (".gitmodules", GITLINK, True),
    ],
)
def test_a_path_passes_the_rule_git_checks_out_by(path, mode, expected):
    assert valid_path(path, mode) is expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "shape,line",
    [
        ("root", "ls-tree odd"),
        ("root", "ls-tree odd a.txt"),
        ("root", "cat-file -p odd^{tree}"),
        ("root", "show odd^{tree}"),
        ("root", "rev-parse odd:a.txt"),
        ("root", "show odd:a.txt"),
        ("root", "restore --source odd a.txt"),
        ("root", "diff-tree odd"),
        ("nested", "ls-tree -r odd"),
        ("nested", "ls-tree odd sub/"),
        ("nested", "cat-file -p odd:sub"),
        ("nested", "rev-parse odd:sub/x.txt"),
        *(
            (shape, line)
            for shape in EMPTY_NAMED
            for line in (
                "show odd",
                "show --stat odd",
                "log -p odd",
                "log --stat odd",
                "log --name-only odd",
                "diff HEAD odd",
                "diff --stat HEAD odd",
                "diff odd HEAD",
                "grep x odd",
                "checkout odd",
                "switch odd",
                "restore --source odd .",
            )
        ),
    ],
)
async def test_a_tree_entry_with_an_empty_name_is_fatal(
    git_rw, repo_path: Path, shape, line
):
    branch_with_paths(repo_path, "odd", EMPTY_NAMED[shape])
    files = {p: p.read_bytes() for p in repo_path.glob("*.txt")}
    code, _, stderr = await run(git_rw, line)
    assert (code, stderr) == (128, EMPTY_NAME)
    assert {p: p.read_bytes() for p in repo_path.glob("*.txt")} == files
    assert not (repo_path / "x.txt").exists()
    head = await run(git_rw, "rev-parse --abbrev-ref HEAD")
    assert head[1] == b"main\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "shape,line",
    [
        ("root", "log --oneline odd"),
        ("root", "cat-file -t odd^{tree}"),
        ("root", "cat-file -s odd^{tree}"),
        ("root", "rev-parse odd:"),
        ("nested", "ls-tree odd"),
        ("nested", "cat-file -p odd^{tree}"),
        ("nested", "rev-parse odd:a.txt"),
        ("nested", "diff-tree odd"),
    ],
)
async def test_a_read_that_decodes_no_empty_name_goes_on(
    git_rw, repo_path: Path, shape, line
):
    branch_with_paths(repo_path, "odd", EMPTY_NAMED[shape])
    code, _, stderr = await run(git_rw, line)
    assert (code, stderr) == (0, b"")


@pytest.mark.asyncio
@pytest.mark.parametrize("shape", list(EMPTY_NAMED))
@pytest.mark.parametrize("line", ["reset", "reset -- a.txt", "status"])
async def test_a_head_with_an_empty_entry_name_is_fatal(
    git_rw, repo_path: Path, shape, line
):
    branch_with_paths(repo_path, "odd", EMPTY_NAMED[shape])
    await run(git_rw, "symbolic-ref HEAD refs/heads/odd")
    index = (repo_path / ".git" / "index").read_bytes()
    assert (await run(git_rw, line)) == (128, b"", EMPTY_NAME)
    assert (repo_path / ".git" / "index").read_bytes() == index


@pytest.mark.asyncio
async def test_fsck_names_a_tree_with_an_empty_entry_name(
    git_rw, repo_path: Path
):
    branch_with_paths(repo_path, "odd", EMPTY_NAMED["root"])
    tree = (await run(git_rw, "rev-parse odd^{tree}"))[1].strip()
    code, _, stderr = await run(git_rw, "fsck")
    assert code == 1
    assert stderr == b"error: object %s: empty filename in tree entry\n" % tree
