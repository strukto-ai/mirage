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
from dulwich.index import Index, IndexEntry
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.restore import index_tree, parse_flags
from mirage.commands.spec.types import FlagView
from mirage.resource.disk import DiskResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from tests.commands.cli.builtin.git.conftest import (commit_gitlink,
                                                     conflict_index)


async def run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.execute(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def test_the_worktree_is_the_default_target():
    parsed = parse_flags(FlagView({}))
    assert (parsed.staged, parsed.worktree) == (False, True)


def test_staged_alone_leaves_the_worktree_out():
    parsed = parse_flags(FlagView({"staged": True}))
    assert (parsed.staged, parsed.worktree) == (True, False)


def test_both_targets_can_be_named():
    parsed = parse_flags(FlagView({"staged": True, "worktree": True}))
    assert (parsed.staged, parsed.worktree) == (True, True)


def test_the_index_reads_as_a_tree():
    entry = IndexEntry(ctime=0,
                       mtime=0,
                       dev=0,
                       ino=0,
                       mode=0o100644,
                       uid=0,
                       gid=0,
                       size=3,
                       sha=b"a" * 40)
    assert index_tree({b"a.txt": entry}) == {b"a.txt": (0o100644, b"a" * 40)}


@pytest.mark.asyncio
async def test_restore_puts_an_edit_back(git_rw, repo_path: Path):
    await git_rw.execute("echo edited > /repo/a.txt")
    assert await run(git_rw, "restore a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "one changed\n"
    assert (await run(git_rw, "status --porcelain"))[1] == b""


@pytest.mark.asyncio
async def test_staged_unstages_and_keeps_the_edit(git_rw, repo_path: Path):
    await git_rw.execute("echo edited > /repo/a.txt")
    await run(git_rw, "add a.txt")
    assert await run(git_rw, "restore --staged a.txt") == (0, b"", b"")
    assert (await run(git_rw, "status --porcelain"))[1] == b" M a.txt\n"
    assert (repo_path / "a.txt").read_text() == "edited\n"


@pytest.mark.asyncio
async def test_both_targets_go_back_to_head(git_rw, repo_path: Path):
    await git_rw.execute("echo edited > /repo/a.txt")
    await run(git_rw, "add a.txt")
    await git_rw.execute("echo again > /repo/a.txt")
    assert await run(git_rw, "restore -SW a.txt") == (0, b"", b"")
    assert (await run(git_rw, "status --porcelain"))[1] == b""
    assert (repo_path / "a.txt").read_text() == "one changed\n"


@pytest.mark.asyncio
async def test_an_unknown_path_is_an_error_not_a_fatal(git_rw):
    code, _out, err = await run(git_rw, "restore nosuch")
    assert code == 1
    assert err == (b"error: pathspec 'nosuch' did not match any file(s) "
                   b"known to git\n")


@pytest.mark.asyncio
async def test_no_pathspec_is_fatal(git_rw):
    code, _out, err = await run(git_rw, "restore")
    assert code == 128
    assert err == b"fatal: you must specify path(s) to restore\n"


@pytest.mark.asyncio
async def test_a_source_restores_from_that_tree(git_rw, repo_path: Path):
    assert await run(git_rw, "restore --source HEAD~1 a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "one\n"
    assert (await run(git_rw, "status --porcelain"))[1] == b" M a.txt\n"


@pytest.mark.asyncio
async def test_a_bad_source_is_fatal(git_rw):
    code, _out, err = await run(git_rw, "restore -s nosuch a.txt")
    assert code == 128
    assert err == b"fatal: could not resolve nosuch\n"


@pytest.mark.asyncio
async def test_staged_turns_a_new_file_back_into_untracked(git_rw):
    await git_rw.execute("echo n > /repo/new.txt")
    await run(git_rw, "add new.txt")
    await run(git_rw, "restore --staged new.txt")
    assert (await run(git_rw, "status --porcelain"))[1] == b"?? new.txt\n"


@pytest.mark.asyncio
async def test_a_path_the_source_lacks_is_removed_from_the_target(
        git_rw, repo_path: Path):
    # b.txt arrived in the second commit, so the first tree lacks it, and
    # restoring both targets from that tree removes it from both.
    assert await run(git_rw, "restore -s HEAD~2 -SW b.txt") == (0, b"", b"")
    assert not (repo_path / "b.txt").exists()
    assert (await run(git_rw, "status --porcelain"))[1] == b"D  b.txt\n"


@pytest.mark.asyncio
async def test_a_deleted_file_comes_back(git_rw, repo_path: Path):
    (repo_path / "a.txt").unlink()
    await git_rw.execute("ls /repo")
    assert await run(git_rw, "restore a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "one changed\n"


@pytest.mark.asyncio
async def test_restoring_the_index_clears_the_conflict_stages(
        git_rw, repo_path: Path):
    conflict_index(repo_path, "a.txt")
    assert await run(git_rw, "restore --staged a.txt") == (0, b"", b"")
    index = Index(str(repo_path / ".git" / "index"))
    assert not index.has_conflicts()
    assert isinstance(index[b"a.txt"], IndexEntry)


@pytest.mark.asyncio
async def test_a_raw_tree_is_a_source(git_rw, repo_path: Path):
    with Repo(str(repo_path)) as repo:
        tree = repo[b"HEAD"].tree.decode()
    await git_rw.execute("echo edited > /repo/a.txt")
    assert await run(git_rw, f"restore --source={tree} a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "one changed\n"


@pytest.mark.asyncio
async def test_a_source_that_is_no_tree_is_still_refused(git_rw):
    code, _out, err = await run(git_rw, "restore --source=nosuch a.txt")
    assert code == 128
    assert err == b"fatal: could not resolve nosuch\n"


@pytest.mark.asyncio
async def test_a_directory_source_replaces_a_file(git_rw, repo_path: Path):
    await run(git_rw, "rm --cached a.txt")
    (repo_path / "a.txt").unlink()
    (repo_path / "a.txt").mkdir()
    (repo_path / "a.txt" / "child").write_text("inner\n", encoding="utf-8")
    await run(git_rw, "add a.txt")
    await run(git_rw, "commit -m dir")
    with Repo(str(repo_path)) as repo:
        tree = repo[b"HEAD"].tree.decode()
    await run(git_rw, "rm -r --cached a.txt")
    (repo_path / "a.txt" / "child").unlink()
    (repo_path / "a.txt").rmdir()
    (repo_path / "a.txt").write_text("flat\n", encoding="utf-8")
    await run(git_rw, "add a.txt")
    assert await run(git_rw,
                     f"restore --source={tree} -SW a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt" / "child").read_text() == "inner\n"
    # The source is HEAD's tree, so a restore that reached both the index
    # and the working tree leaves nothing for status to report.
    assert (await run(git_rw, "status --porcelain"))[1] == b""


@pytest.mark.asyncio
async def test_a_file_source_replaces_a_directory(git_rw, repo_path: Path):
    with Repo(str(repo_path)) as repo:
        tree = repo[b"HEAD"].tree.decode()
    await run(git_rw, "rm --cached a.txt")
    (repo_path / "a.txt").unlink()
    (repo_path / "a.txt").mkdir()
    (repo_path / "a.txt" / "child").write_text("inner\n", encoding="utf-8")
    await run(git_rw, "add a.txt")
    assert await run(git_rw,
                     f"restore --source={tree} -SW a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "one changed\n"
    assert not (repo_path / "a.txt" / "child").exists()


@pytest.mark.asyncio
async def test_a_conflict_the_source_cannot_put_back_is_refused(
        git_rw, repo_path: Path):
    # Added on this side only, so HEAD holds nothing to restore from
    # and the index holds no stage 0 either. git names the path rather
    # than reporting a pathspec it does not recognise.
    (repo_path / "c.txt").write_text("mine\n", encoding="utf-8")
    assert (await run(git_rw, "add c.txt"))[0] == 0
    conflict_index(repo_path, "c.txt")
    code, _out, err = await run(git_rw, "restore --staged c.txt")
    assert code == 1
    assert err == b"error: path 'c.txt' is unmerged\n"
    assert Index(str(repo_path / ".git" / "index")).has_conflicts()


@pytest.mark.asyncio
async def test_restoring_a_conflict_from_the_index_is_refused(
        git_rw, repo_path: Path):
    # The working tree restores from the index, and an unmerged path
    # has no stage 0 there whatever HEAD holds.
    conflict_index(repo_path, "a.txt")
    code, _out, err = await run(git_rw, "restore a.txt")
    assert code == 1
    assert err == b"error: path 'a.txt' is unmerged\n"


@pytest.mark.asyncio
async def test_every_unrestorable_conflict_is_named(git_rw, repo_path: Path):
    conflict_index(repo_path, "a.txt")
    conflict_index(repo_path, "b.txt")
    code, _out, err = await run(git_rw, "restore a.txt b.txt")
    assert code == 1
    assert err == (b"error: path 'a.txt' is unmerged\n"
                   b"error: path 'b.txt' is unmerged\n")


@pytest.mark.asyncio
async def test_a_source_holding_the_conflict_restores_it(
        git_rw, repo_path: Path):
    (repo_path / "c.txt").write_text("mine\n", encoding="utf-8")
    assert (await run(git_rw, "add c.txt"))[0] == 0
    assert (await run(git_rw, "commit -m added"))[0] == 0
    (repo_path / "c.txt").write_text("theirs\n", encoding="utf-8")
    assert (await run(git_rw, "add c.txt"))[0] == 0
    conflict_index(repo_path, "c.txt")
    assert await run(git_rw, "restore --staged c.txt") == (0, b"", b"")
    index = Index(str(repo_path / ".git" / "index"))
    assert not index.has_conflicts()


@pytest.mark.asyncio
async def test_a_tree_peel_is_a_source(git_rw, repo_path: Path):
    # git's own help says --source <tree-ish>, and a peel is the
    # ordinary way to spell one. Probed on git 2.50.1: exit 0.
    await git_rw.execute("echo edited > /repo/a.txt")
    assert await run(git_rw,
                     "restore --source=HEAD^{tree} a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "one changed\n"


@pytest.mark.asyncio
async def test_a_tag_peel_is_a_source(git_rw, repo_path: Path):
    assert (await run(git_rw, "tag v1"))[0] == 0
    await git_rw.execute("echo edited > /repo/a.txt")
    assert await run(git_rw,
                     "restore --source=v1^{tree} a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "one changed\n"


@pytest.mark.asyncio
async def test_a_subtree_at_a_path_is_a_source(git_rw, repo_path: Path):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "a.txt").write_text("nested\n", encoding="utf-8")
    assert (await run(git_rw, "add sub"))[0] == 0
    assert (await run(git_rw, "commit -m nested"))[0] == 0
    assert await run(git_rw,
                     "restore --source=HEAD:sub a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "nested\n"


@pytest.mark.asyncio
async def test_a_source_that_is_no_tree_is_named_by_its_id(git_rw):
    # git reports the object it reached, not the spelling: the name
    # resolved fine and what it found was the problem.
    code, _out, err = await run(git_rw, "restore --source=HEAD:a.txt a.txt")
    assert code == 128
    assert err.startswith(b"fatal: unable to read tree (")
    assert err.endswith(b")\n")


@pytest.mark.asyncio
async def test_a_peel_that_resolves_to_nothing_is_named_as_typed(git_rw):
    code, _out, err = await run(git_rw, "restore --source=nosuch^{tree} a.txt")
    assert code == 128
    assert err == b"fatal: could not resolve nosuch^{tree}\n"


@pytest.mark.asyncio
async def test_a_file_replaces_a_directory_an_untracked_file_holds(
        git_rw, repo_path: Path):
    # The source keeps a.txt as a file, the index keeps a.txt/child, and
    # an untracked a.txt/keep holds the directory open. git replaces the
    # whole directory here, untracked child and all, and exits 0
    # (probed on git 2.50.1); the write would otherwise fail with the
    # index already changed.
    with Repo(str(repo_path)) as repo:
        tree = repo[b"HEAD"].tree.decode()
    await run(git_rw, "rm --cached a.txt")
    (repo_path / "a.txt").unlink()
    (repo_path / "a.txt").mkdir()
    (repo_path / "a.txt" / "child").write_text("inner\n", encoding="utf-8")
    await run(git_rw, "add a.txt/child")
    (repo_path / "a.txt" / "keep").write_text("untracked\n", encoding="utf-8")
    assert await run(git_rw,
                     f"restore --source={tree} -SW a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").is_file()
    assert (repo_path / "a.txt").read_text() == "one changed\n"


@pytest.mark.asyncio
async def test_a_staged_restore_before_the_first_commit_is_refused(unborn_rw):
    await unborn_rw.execute("echo hi > /repo/f.txt")
    await run(unborn_rw, "add f.txt")
    assert await run(
        unborn_rw,
        "restore --staged f.txt") == (128, b"",
                                      b"fatal: could not resolve HEAD\n")
    # The refusal comes before the index is touched: reading the
    # unborn HEAD as an empty tree unstaged the path and said nothing.
    assert await run(unborn_rw, "status --short") == (0, b"A  f.txt\n", b"")


@pytest.mark.asyncio
async def test_staged_and_worktree_together_refuse_the_same_way(unborn_rw):
    await unborn_rw.execute("echo hi > /repo/f.txt")
    await run(unborn_rw, "add f.txt")
    assert await run(
        unborn_rw,
        "restore -SW f.txt") == (128, b"", b"fatal: could not resolve HEAD\n")


@pytest.mark.asyncio
async def test_a_worktree_restore_before_the_first_commit_still_goes(
        unborn_rw):
    await unborn_rw.execute("echo hi > /repo/f.txt")
    await run(unborn_rw, "add f.txt")
    await unborn_rw.execute("echo edited > /repo/f.txt")
    # The working tree restores from the index, which exists before the
    # first commit, so only the implicit HEAD source has nothing to read.
    assert await run(unborn_rw, "restore f.txt") == (0, b"", b"")
    assert (await unborn_rw.execute("cat /repo/f.txt")).stdout == b"hi\n"


@pytest.mark.asyncio
async def test_a_link_standing_where_a_directory_belongs_is_replaced(
        git_rw, repo_path: Path):
    await git_rw.execute("mkdir /repo/slot && echo c > /repo/slot/child")
    await run(git_rw, "add -A")
    await run(git_rw, "commit -m nested")
    await git_rw.execute("rm -r /repo/slot && mkdir /repo/elsewhere")
    await git_rw.execute("echo old > /repo/elsewhere/child")
    await git_rw.execute("ln -s elsewhere /repo/slot")
    assert await run(git_rw, "restore slot/child") == (0, b"", b"")
    # git replaces the link with the directory the entry needs. Writing
    # through it would have landed the content in elsewhere/child, a
    # file no branch named, and left the link in place.
    assert (repo_path / "slot" / "child").read_text() == "c\n"
    assert (repo_path / "elsewhere" / "child").read_text() == "old\n"
    # A link is namespace state, so the disk mount never held one:
    # whether it is gone is a question for the namespace.
    assert (await git_rw.execute("readlink /repo/slot")).exit_code != 0


@pytest.mark.asyncio
async def test_a_removal_is_not_attempted_through_a_link(
        git_rw, repo_path: Path):
    await git_rw.execute("mkdir /repo/slot && echo c > /repo/slot/child")
    await run(git_rw, "add -A")
    await run(git_rw, "commit -m nested")
    await git_rw.execute("rm -r /repo/slot && mkdir /repo/elsewhere")
    await git_rw.execute("echo old > /repo/elsewhere/child")
    await git_rw.execute("ln -s elsewhere /repo/slot")
    # HEAD~1 predates the entry, so restoring from it removes the path.
    assert await run(git_rw,
                     "restore --source=HEAD~1 slot/child") == (0, b"", b"")
    # The source does not hold the path, so the entry would be removed;
    # the unlink would resolve past the link and delete a file inside
    # whatever it points at. git checks the leading path and removes
    # nothing, link and target both left as they stand.
    assert (repo_path / "elsewhere" / "child").read_text() == "old\n"
    told = await git_rw.execute("readlink /repo/slot")
    assert (told.exit_code, told.stdout) == (0, b"elsewhere\n")


@pytest.mark.asyncio
async def test_a_bare_tag_id_still_names_a_source_tree(git_rw,
                                                       repo_path: Path):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    with Repo(str(repo_path)) as repo:
        held = repo.refs[b"refs/tags/v1"].decode()
    await git_rw.execute("echo edited > /repo/a.txt")
    # The id names the tag object itself, which is no tree-ish; a source
    # unwraps it, so `--source=<tag-id>` reads what `--source=v1` reads.
    assert await run(git_rw, f"restore --source={held} a.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").read_text() == "one changed\n"


@pytest.mark.asyncio
async def test_a_file_standing_where_a_directory_belongs_is_replaced(git_rw):
    # The symlink case's other half, and the commoner one: an untracked
    # regular file on the way to the entry. git's create_directories
    # unlinks any leading non-directory and makes the directory, so the
    # restore succeeds and the file is gone. Left unhandled, the write
    # failed with a raw ENOTDIR the caller could do nothing with.
    await git_rw.execute("mkdir /repo/slot && echo c > /repo/slot/child")
    assert (await run(git_rw, "add slot/child"))[0] == 0
    assert (await run(git_rw, "commit -m child"))[0] == 0
    await git_rw.execute("rm -rf /repo/slot && echo untracked > /repo/slot")
    assert await run(git_rw, "restore slot/child") == (0, b"", b"")
    assert (await git_rw.execute("cat /repo/slot/child")).stdout == b"c\n"


@pytest.mark.asyncio
async def test_a_removal_is_not_attempted_through_a_file_either(git_rw):
    # The removal direction takes it the other way, exactly as it takes
    # a link: git checks the leading path and removes nothing, so the
    # untracked file standing there is left alone.
    await git_rw.execute("mkdir /repo/slot && echo c > /repo/slot/child")
    assert (await run(git_rw, "add slot/child"))[0] == 0
    assert (await run(git_rw, "commit -m child"))[0] == 0
    await git_rw.execute("rm -rf /repo/slot && echo untracked > /repo/slot")
    assert await run(git_rw,
                     "restore --source=HEAD~1 slot/child") == (0, b"", b"")
    assert (await git_rw.execute("cat /repo/slot")).stdout == b"untracked\n"


@pytest.mark.asyncio
async def test_the_executable_bit_comes_back_with_the_content(git_rw):
    # git records exactly one permission bit and restores it. Writing
    # the bytes alone left the file unrunnable and left status calling
    # it modified for ever, since the mode is half of what the index
    # staged.
    await git_rw.execute("printf '#!/bin/sh\n' > /repo/s.sh")
    await git_rw.execute("chmod 755 /repo/s.sh")
    assert (await run(git_rw, "add s.sh"))[0] == 0
    assert (await run(git_rw, "commit -m script"))[0] == 0
    await git_rw.execute("chmod 644 /repo/s.sh")
    assert (await run(git_rw, "status --short"))[1] == b" M s.sh\n"
    assert await run(git_rw, "restore s.sh") == (0, b"", b"")
    listed = await git_rw.execute("ls -l /repo/s.sh")
    assert (listed.stdout or b"").startswith(b"-rwxr-xr-x")
    assert (await run(git_rw, "status --short"))[1] == b""


@pytest.mark.asyncio
async def test_the_bit_is_cleared_the_other_way_too(git_rw):
    await git_rw.execute("printf 'plain\n' > /repo/p.txt")
    assert (await run(git_rw, "add p.txt"))[0] == 0
    assert (await run(git_rw, "commit -m plain"))[0] == 0
    await git_rw.execute("chmod 755 /repo/p.txt")
    assert (await run(git_rw, "status --short"))[1] == b" M p.txt\n"
    assert await run(git_rw, "restore p.txt") == (0, b"", b"")
    listed = await git_rw.execute("ls -l /repo/p.txt")
    assert (listed.stdout or b"").startswith(b"-rw-r--r--")
    assert (await run(git_rw, "status --short"))[1] == b""


@pytest.mark.asyncio
async def test_a_directory_holding_a_nested_mount_is_refused(
        repo_path: Path, tmp_path: Path):
    # The tree records a file where the working tree has a directory,
    # so restoring it means removing the directory whole. A nested
    # mount inside it is a different backend entirely: readdir merges
    # it into the listing, so the walk would empty a store no branch
    # ever recorded and then take its root with it.
    inner = tmp_path / "inner"
    inner.mkdir()
    (inner / "precious.txt").write_text("precious\n", encoding="utf-8")
    with Workspace(
        {
            "/repo/": DiskResource(root=str(repo_path)),
            "/repo/slot/data/": DiskResource(root=str(inner)),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("printf 'i am a file\n' > /repo/slot")
        assert (await run(ws, "add slot"))[0] == 0
        assert (await run(ws, "commit -m slotted"))[0] == 0
        await ws.execute("rm /repo/slot")
        await ws.execute("mkdir /repo/slot")
        code, _out, err = await run(ws, "restore slot")
        assert code == 128
        assert err == (b"fatal: cannot remove '/repo/slot': "
                       b"'/repo/slot/data' is a mount root\n")
    assert (inner / "precious.txt").exists()


@pytest.mark.asyncio
async def test_pruning_a_parent_leaves_a_mount_root_alone(
        repo_path: Path, tmp_path: Path):
    # The other removal path: git drops a directory the moment its last
    # tracked file leaves it, and the mount root is the one directory
    # that is not git's to drop.
    inner = tmp_path / "held"
    inner.mkdir()
    with Workspace(
        {
            "/repo/": DiskResource(root=str(repo_path)),
            "/repo/slot/data/": DiskResource(root=str(inner)),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("printf 'x\n' > /repo/slot/data/x.txt")
        assert (await run(ws, "add slot/data/x.txt"))[0] == 0
        assert (await run(ws, "commit -m inside"))[0] == 0
        assert (await run(ws, "rm slot/data/x.txt"))[0] == 0
    assert inner.is_dir()


@pytest.mark.asyncio
async def test_the_index_waits_for_the_worktree_pass_to_be_possible(
        repo_path: Path, tmp_path: Path):
    # -SW stages first and restores after, so a refusal in the second
    # pass used to leave the index moved and the working tree exactly
    # as it was: a fatal that changed something, which this verb has no
    # wording for.
    inner = tmp_path / "kept"
    inner.mkdir()
    (inner / "precious.txt").write_text("precious\n", encoding="utf-8")
    with Workspace(
        {
            "/repo/": DiskResource(root=str(repo_path)),
            "/repo/slot/data/": DiskResource(root=str(inner)),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("printf 'i am a file\n' > /repo/slot")
        assert (await run(ws, "add slot"))[0] == 0
        assert (await run(ws, "commit -m slotted"))[0] == 0
        await ws.execute("rm /repo/slot")
        await ws.execute("mkdir /repo/slot")
        assert (await run(ws, "rm --cached slot"))[0] == 0
        before = (await run(ws, "status --short"))[1]
        assert before.startswith(b"D  slot\n")
        code, _out, err = await run(ws, "restore -SW slot")
        assert code == 128
        assert err == (b"fatal: cannot remove '/repo/slot': "
                       b"'/repo/slot/data' is a mount root\n")
        assert (await run(ws, "status --short"))[1] == before
    assert (inner / "precious.txt").exists()


@pytest.mark.asyncio
async def test_the_staged_half_alone_is_untouched_by_the_preflight(
        repo_path: Path, tmp_path: Path):
    # --staged never touches the working tree, so the mount is not in
    # its way and the line must still go through.
    inner = tmp_path / "spare"
    inner.mkdir()
    with Workspace(
        {
            "/repo/": DiskResource(root=str(repo_path)),
            "/repo/slot/data/": DiskResource(root=str(inner)),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.execute("printf 'i am a file\n' > /repo/slot")
        assert (await run(ws, "add slot"))[0] == 0
        assert (await run(ws, "commit -m slotted"))[0] == 0
        await ws.execute("rm /repo/slot")
        await ws.execute("mkdir /repo/slot")
        assert (await run(ws, "rm --cached slot"))[0] == 0
        assert await run(ws, "restore --staged slot") == (0, b"", b"")
        assert (await run(ws, "status --short"))[1].startswith(b" D slot\n")


@pytest.mark.asyncio
async def test_a_gitlink_keeps_the_working_tree_it_already_has(
        git_rw, repo_path: Path):
    # A 160000 entry names a commit in another repository. git checks
    # out no submodule content without --recurse-submodules, so all the
    # entry asks of the working tree is that a directory stand at the
    # name: reading it as a blob wrote an empty file over the whole
    # directory, untracked work included.
    await git_rw.execute("mkdir /repo/sub && echo keep > /repo/sub/keep.txt")
    commit_gitlink(repo_path, "sub")
    assert await run(git_rw, "restore sub") == (0, b"", b"")
    assert (repo_path / "sub").is_dir()
    assert (repo_path / "sub" /
            "keep.txt").read_text(encoding="utf-8") == "keep\n"


@pytest.mark.asyncio
async def test_a_gitlink_with_nothing_there_gets_a_directory(
        git_rw, repo_path: Path):
    await git_rw.execute("mkdir /repo/sub && echo keep > /repo/sub/keep.txt")
    commit_gitlink(repo_path, "sub")
    await git_rw.execute("rm -rf /repo/sub")
    assert await run(git_rw, "restore sub") == (0, b"", b"")
    assert (repo_path / "sub").is_dir()
    assert sorted(p.name for p in (repo_path / "sub").iterdir()) == []


@pytest.mark.asyncio
async def test_a_file_standing_where_a_gitlink_belongs_is_replaced(
        git_rw, repo_path: Path):
    # git's own answer: the file goes and an empty directory takes its
    # place, which is what it does to any non-directory at the name.
    await git_rw.execute("mkdir /repo/sub && echo keep > /repo/sub/keep.txt")
    commit_gitlink(repo_path, "sub")
    await git_rw.execute("rm -rf /repo/sub")
    await git_rw.execute("printf 'i am a file\n' > /repo/sub")
    assert await run(git_rw, "restore sub") == (0, b"", b"")
    assert (repo_path / "sub").is_dir()


@pytest.mark.asyncio
async def test_a_child_under_a_restored_gitlink_keeps_its_working_copy(
        git_rw, repo_path: Path):
    # Restoring the gitlink drops the child's index entry and leaves
    # the file alone: git writes the directory and touches nothing
    # under it. Removing it here loses content nothing has a copy of,
    # since the source tree never held it.
    await git_rw.execute("mkdir /repo/sub && echo keep > /repo/sub/keep.txt")
    commit_gitlink(repo_path, "sub")
    await git_rw.execute("echo child > /repo/sub/child.txt")
    assert (await run(git_rw, "add sub/child.txt"))[0] == 0
    assert await run(git_rw,
                     "restore --staged --worktree sub") == (0, b"", b"")
    assert (repo_path / "sub" /
            "child.txt").read_text(encoding="utf-8") == "child\n"
    with Repo(str(repo_path)) as repo:
        assert b"sub/child.txt" not in repo.open_index()


@pytest.mark.asyncio
async def test_a_removed_gitlink_takes_an_empty_directory(
        git_rw, repo_path: Path):
    # What stands at a 160000 entry is a directory, so removing the
    # entry is an rmdir: unlink died on it with the index already
    # written.
    await git_rw.execute("mkdir /repo/sub")
    commit_gitlink(repo_path, "sub")
    assert await run(
        git_rw,
        "restore --source=HEAD~1 --staged --worktree sub") == (0, b"", b"")
    assert not (repo_path / "sub").exists()


@pytest.mark.asyncio
async def test_a_removed_gitlink_keeps_a_directory_that_is_not_empty(
        git_rw, repo_path: Path):
    # git warns and goes on rather than failing: the checkout succeeded,
    # and what is left is a directory it will not empty for anyone.
    await git_rw.execute("mkdir /repo/sub && echo keep > /repo/sub/keep.txt")
    commit_gitlink(repo_path, "sub")
    code, out, err = await run(
        git_rw, "restore --source=HEAD~1 --staged "
        "--worktree sub")
    assert (code, out) == (0, b"")
    assert err == b"warning: unable to rmdir 'sub': Directory not empty\n"
    assert (repo_path / "sub" /
            "keep.txt").read_text(encoding="utf-8") == "keep\n"
