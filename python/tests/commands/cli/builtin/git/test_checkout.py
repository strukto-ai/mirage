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

import posixpath
from pathlib import Path

import pytest
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.checkout import (_blocked_ancestors,
                                                      _blocked_descendants,
                                                      _conflicts)
from mirage.resource.disk import DiskResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from tests.commands.cli.builtin.git.conftest import (branch_with_gitlink,
                                                     commit_gitlink,
                                                     conflict_index)

MODE = 0o100644


async def run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.execute(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def head_ref(repo_path: Path) -> bytes:
    """What ``.git/HEAD`` holds, read straight off disk.

    Args:
        repo_path (Path): the repository's working tree.
    """
    return (repo_path / ".git" / "HEAD").read_bytes().strip()


async def write(ws, name: str, text: str) -> None:
    """Create a file through the mount rather than behind its back.

    A mount caches its listings, so a file dropped straight onto disk
    after a command has already walked the tree stays invisible to every
    command after it, and a test written that way passes for the wrong
    reason.

    Args:
        ws (Workspace): the writable workspace.
        name (str): repository-relative path to write.
        text (str): one word of content; a newline is appended.
    """
    parent = posixpath.dirname(name)
    if parent:
        await ws.execute(f"mkdir -p /repo/{parent}")
    await ws.execute(f"echo {text} > /repo/{name}")


async def branch_holding(ws, name: str, path: str, text: str) -> None:
    """Make a branch that holds one file main does not, then leave it.

    Args:
        ws (Workspace): the writable workspace.
        name (str): the branch to create.
        path (str): repository-relative path only the branch holds.
        text (str): the content the branch records for it.
    """
    await run(ws, f"checkout -b {name}")
    await write(ws, path, text)
    await run(ws, "add -A")
    await run(ws, f"commit -m {name}")
    await run(ws, "checkout main")


async def branch_at(ws, repo_path: Path, name: str) -> None:
    """Make a branch holding one extra commit, then go back.

    Args:
        ws (Workspace): the writable workspace.
        repo_path (Path): the repository's working tree.
        name (str): the branch to create.
    """
    await run(ws, f"checkout -b {name}")
    (repo_path / "a.txt").write_text("on the branch\n", encoding="utf-8")
    await run(ws, "add -A")
    await run(ws, "commit -m sideways")
    await run(ws, "checkout main")


def test_a_file_both_branches_agree_on_is_carried():
    # git carries an uncommitted edit across rather than refusing when
    # the target branch records the same content for the path.
    before = {b"a.txt": (MODE, b"a" * 40)}
    after = {b"a.txt": (MODE, b"a" * 40)}
    assert _conflicts(before, after, {"a.txt"}) == []


def test_a_file_the_branches_disagree_on_blocks():
    before = {b"a.txt": (MODE, b"a" * 40)}
    after = {b"a.txt": (MODE, b"b" * 40)}
    assert _conflicts(before, after, {"a.txt"}) == ["a.txt"]


def test_a_file_the_target_does_not_have_blocks():
    before = {b"a.txt": (MODE, b"a" * 40)}
    assert _conflicts(before, {}, {"a.txt"}) == ["a.txt"]


def test_a_clean_file_never_blocks():
    before = {b"a.txt": (MODE, b"a" * 40)}
    after = {b"a.txt": (MODE, b"b" * 40)}
    assert _conflicts(before, after, set()) == []


@pytest.mark.asyncio
async def test_switching_moves_head_to_the_branch(git_rw, repo_path: Path):
    await run(git_rw, "branch topic")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 0
    assert err == b"Switched to branch 'topic'\n"
    assert head_ref(repo_path) == b"ref: refs/heads/topic"


@pytest.mark.asyncio
async def test_switching_to_where_you_already_are_says_so(git_rw):
    _code, _out, err = await run(git_rw, "checkout main")
    assert err == b"Already on 'main'\n"


@pytest.mark.asyncio
async def test_creating_and_switching_in_one_step(git_rw, repo_path: Path):
    code, _out, err = await run(git_rw, "checkout -b shiny")
    assert code == 0
    assert err == b"Switched to a new branch 'shiny'\n"
    assert head_ref(repo_path) == b"ref: refs/heads/shiny"


@pytest.mark.asyncio
async def test_creating_at_a_start_point_branches_from_there(
        git_rw, repo_path: Path):
    # The operand is the whole point of the form: without it every commit
    # after the switch lands on the wrong history.
    with Repo(str(repo_path)) as repo:
        older = repo[repo.refs[b"HEAD"]].parents[0]
    code, _out, err = await run(git_rw, "checkout -b older HEAD~1")
    assert code == 0
    assert err == b"Switched to a new branch 'older'\n"
    with Repo(str(repo_path)) as repo:
        assert repo.refs[b"refs/heads/older"] == older


@pytest.mark.asyncio
async def test_creating_without_a_start_point_branches_from_head(
        git_rw, repo_path: Path):
    with Repo(str(repo_path)) as repo:
        head = repo.refs[b"HEAD"]
    assert (await run(git_rw, "checkout -b shiny"))[0] == 0
    with Repo(str(repo_path)) as repo:
        assert repo.refs[b"refs/heads/shiny"] == head


@pytest.mark.asyncio
async def test_creating_at_a_start_point_that_is_not_a_commit(git_rw):
    code, _out, err = await run(git_rw, "checkout -b shiny nosuchrev")
    assert code == 128
    assert err == (b"fatal: 'nosuchrev' is not a commit and a branch 'shiny' "
                   b"cannot be created from it\n")


@pytest.mark.asyncio
async def test_creating_a_branch_that_exists_is_refused(git_rw):
    await run(git_rw, "branch topic")
    code, _out, err = await run(git_rw, "checkout -b topic")
    assert code == 128
    assert err == b"fatal: a branch named 'topic' already exists\n"


@pytest.mark.asyncio
async def test_an_unknown_target_is_refused(git_rw):
    code, _out, err = await run(git_rw, "checkout nosuchthing")
    assert code == 1
    assert err == (b"error: pathspec 'nosuchthing' did not match any file(s) "
                   b"known to git\n")


@pytest.mark.asyncio
async def test_the_working_tree_follows_the_branch(git_rw, repo_path: Path):
    await branch_at(git_rw, repo_path, "topic")
    assert (repo_path / "a.txt").read_text() == "one changed\n"
    await run(git_rw, "checkout topic")
    assert (repo_path / "a.txt").read_text() == "on the branch\n"


@pytest.mark.asyncio
async def test_an_edit_that_would_be_lost_blocks_the_switch(
        git_rw, repo_path: Path):
    await branch_at(git_rw, repo_path, "topic")
    (repo_path / "a.txt").write_text("precious\n", encoding="utf-8")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 1
    assert b"would be overwritten by checkout" in err
    assert b"\ta.txt" in err
    # The point of the refusal: the edit is still there.
    assert (repo_path / "a.txt").read_text() == "precious\n"
    assert head_ref(repo_path) == b"ref: refs/heads/main"


@pytest.mark.asyncio
async def test_an_edit_to_an_untouched_file_rides_along(
        git_rw, repo_path: Path):
    await branch_at(git_rw, repo_path, "topic")
    (repo_path / "b.txt").write_text("carried\n", encoding="utf-8")
    code, out, _err = await run(git_rw, "checkout topic")
    assert code == 0
    assert out == b"M\tb.txt\n"
    assert (repo_path / "b.txt").read_text() == "carried\n"


@pytest.mark.asyncio
async def test_an_untracked_file_is_left_alone(git_rw, repo_path: Path):
    await branch_at(git_rw, repo_path, "topic")
    (repo_path / "mine.txt").write_text("untracked\n", encoding="utf-8")
    assert (await run(git_rw, "checkout topic"))[0] == 0
    assert (repo_path / "mine.txt").read_text() == "untracked\n"


@pytest.mark.asyncio
async def test_an_untracked_file_the_branch_holds_blocks_the_switch(
        git_rw, repo_path: Path):
    # The dangerous one: the file is in no index and no tree, so the
    # tracked comparison cannot see it, and writing the branch's blob
    # over it destroys the only copy there is.
    await branch_holding(git_rw, "topic", "fresh.txt", "branch")
    await write(git_rw, "fresh.txt", "mine")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 1
    assert err == (b"error: The following untracked working tree files would "
                   b"be overwritten by checkout:\n\tfresh.txt\nPlease move or "
                   b"remove them before you switch branches.\nAborting\n")
    assert (repo_path / "fresh.txt").read_text() == "mine\n"
    assert head_ref(repo_path) == b"ref: refs/heads/main"


@pytest.mark.asyncio
async def test_an_untracked_file_inside_an_untracked_directory_blocks(
        git_rw, repo_path: Path):
    # Status collapses a wholly untracked directory to one `dir/` row,
    # and a collision has to be decided per file. git names the file.
    await branch_holding(git_rw, "topic", "nd/file.txt", "branch")
    await write(git_rw, "nd/file.txt", "mine")
    await write(git_rw, "nd/other.txt", "also")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 1
    assert b"\tnd/file.txt" in err
    assert (repo_path / "nd" / "file.txt").read_text() == "mine\n"


@pytest.mark.asyncio
async def test_an_ignored_file_is_overwritten_without_a_word(
        git_rw, repo_path: Path):
    # git's own split: an ignored file is not work the caller is keeping.
    await run(git_rw, "checkout -b topic")
    await write(git_rw, "ig.txt", "branch")
    await run(git_rw, "add -f ig.txt")
    await run(git_rw, "commit -m ignored")
    await run(git_rw, "checkout main")
    await write(git_rw, ".gitignore", "ig.txt")
    await write(git_rw, "ig.txt", "mine")
    code, _out, _err = await run(git_rw, "checkout topic")
    assert code == 0
    assert (repo_path / "ig.txt").read_text() == "branch\n"


@pytest.mark.asyncio
async def test_both_kinds_of_conflict_are_reported_together(git_rw):
    await run(git_rw, "checkout -b topic")
    await write(git_rw, "a.txt", "onthebranch")
    await write(git_rw, "fresh.txt", "branch")
    await run(git_rw, "add -A")
    await run(git_rw, "commit -m both")
    await run(git_rw, "checkout main")
    await write(git_rw, "a.txt", "precious")
    await write(git_rw, "fresh.txt", "mine")
    code, _out, err = await run(git_rw, "checkout topic")
    assert code == 1
    # One aborting line at the end, and the second paragraph carries its
    # own prefix, which is how git prints two errors before one abort.
    assert err == (b"error: Your local changes to the following files would "
                   b"be overwritten by checkout:\n\ta.txt\nPlease commit your "
                   b"changes or stash them before you switch branches.\n"
                   b"error: The following untracked working tree files would "
                   b"be overwritten by checkout:\n\tfresh.txt\nPlease move or "
                   b"remove them before you switch branches.\nAborting\n")


@pytest.mark.asyncio
async def test_switching_to_a_commit_detaches_head(git_rw, repo_path: Path):
    with Repo(str(repo_path)) as repo:
        older = repo[repo.refs[b"HEAD"]].parents[0].decode()
    code, _out, err = await run(git_rw, f"checkout {older[:7]}")
    assert code == 0
    assert b"detached HEAD" in err
    assert head_ref(repo_path) == older.encode()


@pytest.mark.asyncio
async def test_an_unknown_switch_is_refused(git_rw):
    code, _out, err = await run(git_rw, "checkout -Z")
    assert code == 129
    assert err == b"error: unknown switch `Z'\n"


@pytest.mark.asyncio
async def test_checking_out_a_symlink_restores_a_link_not_a_file(git_rw):
    # A 120000 entry materializes as a link in the working tree, not as
    # a regular file holding the target string. The name plane owns
    # links, so restoring one is a namespace write rather than a
    # content write; writing the blob would leave a 5-byte regular file
    # spelling "a.txt".
    assert (await run(git_rw, "checkout -b side"))[0] == 0
    await git_rw.execute("ln -s a.txt /repo/link")
    assert (await run(git_rw, "add link"))[0] == 0
    assert (await run(git_rw, "commit -m linked"))[0] == 0
    assert (await run(git_rw, "checkout main"))[0] == 0
    assert (await run(git_rw, "checkout side"))[0] == 0
    listing = await git_rw.execute("ls -l /repo/link")
    assert (listing.stdout or b"").startswith(b"lrwxrwxrwx")
    assert b"link -> a.txt" in (listing.stdout or b"")


@pytest.mark.asyncio
async def test_checking_out_a_regular_file_over_a_link_replaces_it(git_rw):
    # git 2.47: a path that is a symlink on one branch and a regular
    # file on the other comes back as a regular file, and the file the
    # link pointed at keeps its own content. Writing through the link
    # instead dereferences it: the blob lands in a.txt, which no branch
    # ever changed, and the link stays in the working tree while HEAD
    # and the index say a file is there.
    assert (await run(git_rw, "checkout -b linked"))[0] == 0
    await git_rw.execute("ln -s a.txt /repo/thing")
    assert (await run(git_rw, "add thing"))[0] == 0
    assert (await run(git_rw, "commit -m link"))[0] == 0
    assert (await run(git_rw, "checkout -b plain"))[0] == 0
    await git_rw.execute("rm /repo/thing")
    await git_rw.execute("printf 'PLAIN\\n' > /repo/thing")
    assert (await run(git_rw, "add thing"))[0] == 0
    assert (await run(git_rw, "commit -m plain"))[0] == 0
    assert (await run(git_rw, "checkout linked"))[0] == 0
    assert (await run(git_rw, "checkout plain"))[0] == 0
    listing = await git_rw.execute("ls -l /repo/thing")
    assert not (listing.stdout or b"").startswith(b"lrwxrwxrwx")
    content = await git_rw.execute("cat /repo/thing")
    assert (content.stdout or b"") == b"PLAIN\n"
    kept = await git_rw.execute("cat /repo/a.txt")
    assert (kept.stdout or b"") == b"one changed\n"


@pytest.mark.asyncio
async def test_checking_out_a_link_over_a_regular_file_replaces_it(git_rw):
    # The mirror: the file must not survive under the link it was
    # replaced by, or removing the link later uncovers content no
    # branch records.
    assert (await run(git_rw, "checkout -b plainfirst"))[0] == 0
    await git_rw.execute("printf 'PLAIN\\n' > /repo/thing")
    assert (await run(git_rw, "add thing"))[0] == 0
    assert (await run(git_rw, "commit -m plain"))[0] == 0
    assert (await run(git_rw, "checkout -b linkedafter"))[0] == 0
    await git_rw.execute("rm /repo/thing")
    await git_rw.execute("ln -s a.txt /repo/thing")
    assert (await run(git_rw, "add thing"))[0] == 0
    assert (await run(git_rw, "commit -m link"))[0] == 0
    assert (await run(git_rw, "checkout plainfirst"))[0] == 0
    assert (await run(git_rw, "checkout linkedafter"))[0] == 0
    await git_rw.execute("rm /repo/thing")
    listing = await git_rw.execute("ls /repo/thing")
    assert b"No such file or directory" in (listing.stderr or b"")


@pytest.mark.asyncio
async def test_checking_out_a_link_that_moved_retargets_it(git_rw):
    # A branch that points the same link somewhere else: symlink(2) does
    # not overwrite, so the checkout removes the old name before writing
    # the new one. Relying on the node table to replace the entry in
    # place left the checkout refused with EEXIST and the link pointing
    # at the other branch's target.
    assert (await run(git_rw, "checkout -b first"))[0] == 0
    await git_rw.execute("ln -s a.txt /repo/lk")
    assert (await run(git_rw, "add lk"))[0] == 0
    assert (await run(git_rw, "commit -m first"))[0] == 0
    assert (await run(git_rw, "checkout -b second"))[0] == 0
    await git_rw.execute("printf 'other\\n' > /repo/b.txt")
    await git_rw.execute("ln -sf b.txt /repo/lk")
    assert (await run(git_rw, "add -A"))[0] == 0
    assert (await run(git_rw, "commit -m second"))[0] == 0
    assert (await run(git_rw, "checkout first"))[0] == 0
    assert (await git_rw.execute("readlink /repo/lk")).stdout == b"a.txt\n"
    assert (await run(git_rw, "checkout second"))[0] == 0
    assert (await git_rw.execute("readlink /repo/lk")).stdout == b"b.txt\n"


@pytest.mark.asyncio
async def test_an_unmerged_index_stops_a_checkout(git_rw, repo_path: Path):
    assert (await run(git_rw, "branch topic"))[0] == 0
    conflict_index(repo_path, "a.txt")
    code, out, err = await run(git_rw, "checkout topic")
    assert code == 1
    assert out == b"a.txt: needs merge\n"
    assert err == b"error: you need to resolve your current index first\n"


@pytest.mark.asyncio
async def test_branching_here_survives_an_unmerged_index(
        git_rw, repo_path: Path):
    conflict_index(repo_path, "a.txt")
    assert (await run(git_rw, "checkout -b topic"))[0] == 0
    with Repo(str(repo_path)) as repo:
        assert repo.open_index().has_conflicts()


def test_an_uncommitted_path_above_a_written_entry_is_blocked():
    writing = {b"slot/child": (MODE, b"0" * 40)}
    assert _blocked_ancestors(writing, {"slot"}) == ["slot"]
    # The entry itself is not its own ancestor, and an unrelated
    # uncommitted path is in nobody's way.
    assert _blocked_ancestors(writing, {"slot/child"}) == []
    assert _blocked_ancestors(writing, {"other"}) == []


async def branch_holding_a_child(ws) -> None:
    """Put ``slot/child`` on a branch ``other`` and come back.

    Args:
        ws (Workspace): workspace with the repository and CLI.
    """
    assert (await run(ws, "switch -c other"))[0] == 0
    await ws.execute("mkdir -p /repo/slot && echo kid > /repo/slot/child")
    assert (await run(ws, "add -f slot/child"))[0] == 0
    assert (await run(ws, "commit -m child"))[0] == 0
    assert (await run(ws, "switch main"))[0] == 0


@pytest.mark.asyncio
async def test_a_staged_file_where_the_target_records_a_directory(git_rw):
    # git allows this and discards the staged addition in silence; this
    # refuses and names it, the same trade _conflicts makes for a staged
    # change. What must not happen either way is the old answer: a raw
    # ENOTDIR after the earlier entries were already written.
    await branch_holding_a_child(git_rw)
    await git_rw.execute("echo staged > /repo/slot")
    assert (await run(git_rw, "add slot"))[0] == 0
    code, _out, err = await run(git_rw, "switch other")
    assert code == 1
    assert err == (b"error: Your local changes to the following files would "
                   b"be overwritten by checkout:\n\tslot\n"
                   b"Please commit your changes or stash them before you "
                   b"switch branches.\nAborting\n")
    # Nothing moved: still on main with the addition still staged.
    assert (await run(git_rw, "status --short"))[1] == b"A  slot\n"


@pytest.mark.asyncio
async def test_an_ignored_link_where_the_target_records_a_directory(git_rw):
    # An ignored path is in neither tree and in no collision list, so it
    # reaches the write. Writing through the link landed the blob in the
    # link's target, corrupting a path no branch named while the link
    # itself survived; git replaces the link instead.
    await git_rw.execute("printf 'slot\\n' > /repo/.gitignore")
    assert (await run(git_rw, "add .gitignore"))[0] == 0
    assert (await run(git_rw, "commit -m ignore"))[0] == 0
    await branch_holding_a_child(git_rw)
    await git_rw.execute(
        "mkdir -p /repo/away && echo outside > /repo/away/child")
    await git_rw.execute("ln -s /repo/away /repo/slot")
    assert (await run(git_rw, "switch other"))[0] == 0
    assert (await git_rw.execute("cat /repo/slot/child")).stdout == b"kid\n"
    # The link's target tree is untouched, and the link itself is gone.
    assert (await
            git_rw.execute("cat /repo/away/child")).stdout == b"outside\n"
    assert (await git_rw.execute("readlink /repo/slot")).exit_code != 0


@pytest.mark.asyncio
async def test_an_ignored_file_where_the_target_records_a_directory(git_rw):
    await git_rw.execute("printf 'slot\\n' > /repo/.gitignore")
    assert (await run(git_rw, "add .gitignore"))[0] == 0
    assert (await run(git_rw, "commit -m ignore"))[0] == 0
    await branch_holding_a_child(git_rw)
    await git_rw.execute("echo ignored > /repo/slot")
    assert (await run(git_rw, "switch other"))[0] == 0
    assert (await git_rw.execute("cat /repo/slot/child")).stdout == b"kid\n"
    assert (await run(git_rw, "status --short"))[1] == b""


@pytest.mark.asyncio
async def test_an_untracked_file_there_is_still_refused(git_rw):
    # Untracked and not ignored is the case git does refuse, and the
    # wording is its own: the replacement above must not reach it.
    await branch_holding_a_child(git_rw)
    await git_rw.execute("echo untracked > /repo/slot")
    code, _out, err = await run(git_rw, "switch other")
    assert code == 1
    assert err == (b"error: The following untracked working tree files would "
                   b"be overwritten by checkout:\n\tslot\n"
                   b"Please move or remove them before you switch "
                   b"branches.\nAborting\n")
    assert (await git_rw.execute("cat /repo/slot")).stdout == b"untracked\n"


@pytest.mark.asyncio
async def test_an_ignored_directory_where_the_target_records_a_file(git_rw):
    # The ancestor cases' other half: the directory stands on the name
    # itself. It holds only ignored files, so the check that refuses a
    # directory is silent (it is about the untracked files one would
    # lose), and git updates ignored files by default and takes the
    # whole directory with it.
    await git_rw.execute("printf 'slot/\n' > /repo/.gitignore")
    assert (await run(git_rw, "add .gitignore"))[0] == 0
    assert (await run(git_rw, "commit -m ignore"))[0] == 0
    assert (await run(git_rw, "switch -c other"))[0] == 0
    await git_rw.execute("echo asfile > /repo/slot")
    assert (await run(git_rw, "add -f slot"))[0] == 0
    assert (await run(git_rw, "commit -m file"))[0] == 0
    assert (await run(git_rw, "switch main"))[0] == 0
    await git_rw.execute("mkdir -p /repo/slot && echo keep > /repo/slot/keep")
    assert (await run(git_rw, "switch other"))[0] == 0
    assert (await git_rw.execute("cat /repo/slot")).stdout == b"asfile\n"


@pytest.mark.asyncio
async def test_a_directory_holding_untracked_files_is_still_refused(git_rw):
    # The other side of the same split, and the reason the removal
    # above cannot be unconditional: an untracked file inside is one
    # git will not lose, and it names the directory rather than the file.
    assert (await run(git_rw, "switch -c other"))[0] == 0
    await git_rw.execute("echo asfile > /repo/slot")
    assert (await run(git_rw, "add slot"))[0] == 0
    assert (await run(git_rw, "commit -m file"))[0] == 0
    assert (await run(git_rw, "switch main"))[0] == 0
    await git_rw.execute("mkdir -p /repo/slot && echo keep > /repo/slot/keep")
    code, _out, err = await run(git_rw, "switch other")
    assert code == 1
    assert err == (b"error: Updating the following directories would lose "
                   b"untracked files in them:\n\tslot\n\nAborting\n")
    assert (await git_rw.execute("cat /repo/slot/keep")).stdout == b"keep\n"


@pytest.mark.asyncio
async def test_a_switch_puts_the_executable_bit_back(git_rw):
    assert (await run(git_rw, "switch -c other"))[0] == 0
    await git_rw.execute("printf '#!/bin/sh\n' > /repo/s.sh")
    await git_rw.execute("chmod 755 /repo/s.sh")
    assert (await run(git_rw, "add s.sh"))[0] == 0
    assert (await run(git_rw, "commit -m script"))[0] == 0
    assert (await run(git_rw, "switch main"))[0] == 0
    assert (await run(git_rw, "switch other"))[0] == 0
    listed = await git_rw.execute("ls -l /repo/s.sh")
    assert (listed.stdout or b"").startswith(b"-rwxr-xr-x")
    assert (await run(git_rw, "status --short"))[1] == b""


def test_a_staged_file_under_a_written_file_blocks():
    # The target records the file ``slot``; the index holds a staged
    # ``slot/child`` that is in neither tree, so the exact-key
    # comparison cannot see it and the directory would have to go.
    writing = {b"slot": (MODE, b"a" * 40)}
    assert _blocked_descendants(writing, {"slot/child"}) == ["slot/child"]
    # The other direction is the ancestor check's, not this one's.
    assert _blocked_descendants({b"slot/child": (MODE, b"a" * 40)},
                                {"slot"}) == []
    assert _blocked_descendants(writing, {"other/child"}) == []


@pytest.mark.asyncio
async def test_a_staged_file_inside_a_directory_the_branch_replaces(
        git_rw, repo_path: Path):
    assert (await run(git_rw, "checkout -b filebranch"))[0] == 0
    await git_rw.execute("printf 'FILE\\n' > /repo/slot")
    assert (await run(git_rw, "add slot"))[0] == 0
    assert (await run(git_rw, "commit -m file"))[0] == 0
    assert (await run(git_rw, "checkout main"))[0] == 0
    await git_rw.execute("mkdir -p /repo/slot && printf 'c\\n' > "
                         "/repo/slot/child")
    assert (await run(git_rw, "add slot/child"))[0] == 0
    code, _out, err = await run(git_rw, "checkout filebranch")
    assert code == 1
    assert b"slot/child" in err
    # Nothing moved: the staged blob is still the only copy there is.
    assert (repo_path / "slot" / "child").exists()


@pytest.mark.asyncio
async def test_replacing_a_directory_does_not_follow_a_link_out_of_it(
        git_rw, repo_path: Path):
    # git takes the link away with the directory and leaves what it
    # pointed at exactly as it was. The link has to be ignored rather
    # than untracked to get this far: an untracked one inside the
    # directory is refused by name. What the walk does on the way is
    # pinned in test_io, since the delete it used to attempt through
    # the link is spelled with the link in the middle and the
    # dispatcher does not resolve one there.
    (repo_path / "outside").mkdir()
    (repo_path / "outside" / "keep.txt").write_text("keep\n", encoding="utf-8")
    assert (await run(git_rw, "checkout -b slotfile"))[0] == 0
    await git_rw.execute("printf 'FILE\\n' > /repo/slot")
    assert (await run(git_rw, "add slot"))[0] == 0
    assert (await run(git_rw, "commit -m file"))[0] == 0
    assert (await run(git_rw, "checkout main"))[0] == 0
    await git_rw.execute("rm /repo/slot")
    await git_rw.execute("printf 'link\\n' > /repo/.gitignore")
    await git_rw.execute("mkdir -p /repo/slot")
    await git_rw.execute("ln -s /repo/outside /repo/slot/link")
    assert (await run(git_rw, "checkout slotfile"))[0] == 0
    assert (repo_path / "outside" / "keep.txt").exists()
    gone = await git_rw.execute("readlink /repo/slot/link")
    assert gone.exit_code != 0


@pytest.mark.asyncio
async def test_a_mount_further_down_the_switch_stops_it_before_it_starts(
        repo_path: Path, tmp_path: Path):
    # The refusal lives in the removal that meets the mount, which the
    # write loop reaches one entry at a time. A branch that changes an
    # earlier path as well would have had that path written already, so
    # the fatal left the working tree on the target's content with HEAD
    # and the index still on the branch being left.
    inner = tmp_path / "held"
    inner.mkdir()
    with Workspace(
        {
            "/repo/": DiskResource(root=str(repo_path)),
            "/repo/slot/data/": DiskResource(root=str(inner)),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("printf 'ignored.txt\n' > /repo/.gitignore")
        assert (await run(ws, "add .gitignore"))[0] == 0
        assert (await run(ws, "commit -m ignores"))[0] == 0
        assert (await run(ws, "checkout -b slotted"))[0] == 0
        await ws.execute("printf 'edited\n' > /repo/a.txt")
        await ws.execute("printf 'v2\n' > /repo/slot")
        assert (await run(ws, "add a.txt slot"))[0] == 0
        assert (await run(ws, "commit -m two"))[0] == 0
        assert (await run(ws, "checkout main"))[0] == 0
        # Only ignored content, so no collision list names the
        # directory and the write loop is what would meet the mount.
        await ws.execute("mkdir -p /repo/slot")
        await ws.execute("printf 'x\n' > /repo/slot/ignored.txt")
        before = (repo_path / "a.txt").read_text(encoding="utf-8")
        code, _out, err = await run(ws, "checkout slotted")
        assert code == 128
        assert err == (b"fatal: cannot remove '/repo/slot': "
                       b"'/repo/slot/data' is a mount root\n")
        # Nothing moved: the earlier path still holds what it held, and
        # the branch is the one the line started on.
        assert (repo_path / "a.txt").read_text(encoding="utf-8") == before
        assert (await run(ws, "status --short"))[1] == b""
    assert inner.is_dir()


@pytest.mark.asyncio
async def test_a_branch_that_adds_a_gitlink_makes_a_directory_for_it(
        git_rw, repo_path: Path):
    # The same rule the write loop follows for restore: a 160000 entry
    # asks only that a directory stand at the name, so a branch adding
    # one must not read it as a blob and write an empty file. Reached
    # with nothing at the name, which is the one shape no collision
    # check refuses first.
    branch_with_gitlink(repo_path, "linked", "sub")
    assert (await run(git_rw, "checkout linked"))[0] == 0
    assert (repo_path / "sub").is_dir()


@pytest.mark.asyncio
async def test_an_unmerged_index_stops_a_checkout_of_the_current_branch(
        git_rw, repo_path: Path):
    conflict_index(repo_path, "a.txt")
    code, out, err = await run(git_rw, "checkout main")
    assert code == 1
    assert out == b"a.txt: needs merge\n"
    assert err == b"error: you need to resolve your current index first\n"


@pytest.mark.asyncio
async def test_a_gitlink_lands_over_a_directory_of_untracked_files(
        git_rw, repo_path: Path):
    # A gitlink asks for a directory, so the one already standing is
    # what it asked for and nothing in it is lost. The collision check
    # read it as a file replacing the directory and aborted a switch
    # git takes.
    branch_with_gitlink(repo_path, "linked", "sub")
    await git_rw.execute("mkdir /repo/sub && echo keep > /repo/sub/keep.txt")
    assert (await run(git_rw, "checkout linked"))[0] == 0
    assert (repo_path / "sub" /
            "keep.txt").read_text(encoding="utf-8") == "keep\n"


@pytest.mark.asyncio
async def test_an_untracked_file_where_a_gitlink_lands_is_still_refused(
        git_rw, repo_path: Path):
    # The other half of git's rule: the directory cannot be made
    # without deleting the file, so this one is named and refused.
    branch_with_gitlink(repo_path, "linked", "sub")
    await git_rw.execute("printf 'mine\n' > /repo/sub")
    code, _out, err = await run(git_rw, "checkout linked")
    assert code == 1
    assert b"would be overwritten by checkout:\n\tsub\n" in err
    assert (repo_path / "sub").read_text(encoding="utf-8") == "mine\n"


@pytest.mark.asyncio
async def test_a_branch_that_drops_a_gitlink_rmdirs_it(git_rw,
                                                       repo_path: Path):
    assert (await run(git_rw, "branch plain"))[0] == 0
    await git_rw.execute("mkdir /repo/sub")
    commit_gitlink(repo_path, "sub")
    code, _out, err = await run(git_rw, "checkout plain")
    assert code == 0
    assert err.endswith(b"Switched to branch 'plain'\n")
    assert not (repo_path / "sub").exists()


@pytest.mark.asyncio
async def test_a_gitlink_directory_that_is_not_empty_is_kept_with_a_warning(
        git_rw, repo_path: Path):
    assert (await run(git_rw, "branch plain"))[0] == 0
    await git_rw.execute("mkdir /repo/sub && echo keep > /repo/sub/keep.txt")
    commit_gitlink(repo_path, "sub")
    code, _out, err = await run(git_rw, "checkout plain")
    assert code == 0
    assert err == (b"warning: unable to rmdir 'sub': Directory not empty\n"
                   b"Switched to branch 'plain'\n")
    assert (repo_path / "sub" /
            "keep.txt").read_text(encoding="utf-8") == "keep\n"
