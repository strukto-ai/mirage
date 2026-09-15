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

from mirage.commands.cli.builtin.git.changes import DELETED, MODIFIED
from mirage.commands.cli.builtin.git.errors import (NotRecursiveError,
                                                    PathspecError)
from mirage.commands.cli.builtin.git.rm import (RmFlags, parse_flags, select,
                                                shadowed)
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.spec.types import FlagView

LOCATION = RepoLocation(gitdir="/repo/.git",
                        commondir="/repo/.git",
                        worktree="/repo",
                        mount_root="/repo")
TRACKED = {"a.txt", "docs/one.md", "docs/two.md"}


def flags(**given: bool) -> RmFlags:
    """An RmFlags with every flag off except the ones named.

    Args:
        given (bool): flags to switch on, by field name.
    """
    return RmFlags(recursive=given.get("recursive", False),
                   cached=given.get("cached", False),
                   force=given.get("force", False),
                   quiet=given.get("quiet", False),
                   ignore_unmatch=given.get("ignore_unmatch", False))


async def run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.execute(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def test_flags_read_their_long_and_short_spellings():
    parsed = parse_flags(
        FlagView({
            "r": True,
            "cached": True,
            "force": True,
            "quiet": True,
            "ignore_unmatch": True
        }))
    assert parsed == flags(recursive=True,
                           cached=True,
                           force=True,
                           quiet=True,
                           ignore_unmatch=True)


def test_a_file_operand_selects_itself():
    assert select(LOCATION, "/repo", ("a.txt", ), TRACKED,
                  flags()) == ["a.txt"]


def test_a_directory_needs_r():
    with pytest.raises(NotRecursiveError):
        select(LOCATION, "/repo", ("docs", ), TRACKED, flags())


def test_r_expands_a_directory_in_index_order():
    assert select(LOCATION, "/repo", ("docs", ), TRACKED,
                  flags(recursive=True)) == ["docs/one.md", "docs/two.md"]


def test_an_unknown_operand_is_fatal_before_anything_is_selected():
    with pytest.raises(PathspecError):
        select(LOCATION, "/repo", ("a.txt", "nosuch"), TRACKED, flags())


def test_ignore_unmatch_skips_an_unknown_operand():
    assert select(LOCATION, "/repo", ("nosuch", "a.txt"), TRACKED,
                  flags(ignore_unmatch=True)) == ["a.txt"]


@pytest.mark.asyncio
async def test_rm_stages_a_deletion_and_removes_the_file(
        git_rw, repo_path: Path):
    assert await run(git_rw, "rm a.txt") == (0, b"rm 'a.txt'\n", b"")
    assert not (repo_path / "a.txt").exists()
    assert (await run(git_rw, "status --porcelain"))[1] == b"D  a.txt\n"


@pytest.mark.asyncio
async def test_cached_keeps_the_file(git_rw, repo_path: Path):
    code, out, _err = await run(git_rw, "rm --cached a.txt")
    assert (code, out) == (0, b"rm 'a.txt'\n")
    assert (repo_path / "a.txt").exists()
    assert (await run(git_rw, "status --porcelain"))[1] == (b"D  a.txt\n"
                                                            b"?? a.txt\n")


@pytest.mark.asyncio
async def test_a_local_modification_is_refused(git_rw, repo_path: Path):
    await git_rw.execute("echo edited > /repo/a.txt")
    code, out, err = await run(git_rw, "rm a.txt")
    assert (code, out) == (1, b"")
    assert err == (
        b"error: the following file has local modifications:\n"
        b"    a.txt\n"
        b"(use --cached to keep the file, or -f to force removal)\n")
    assert (repo_path / "a.txt").exists()


@pytest.mark.asyncio
async def test_a_staged_change_is_refused_with_its_own_wording(git_rw):
    await git_rw.execute("echo edited > /repo/a.txt")
    await run(git_rw, "add a.txt")
    _code, _out, err = await run(git_rw, "rm a.txt")
    assert err.startswith(b"error: the following file has changes staged "
                          b"in the index:\n    a.txt\n")


@pytest.mark.asyncio
async def test_force_removes_over_an_edit(git_rw, repo_path: Path):
    await git_rw.execute("echo edited > /repo/a.txt")
    assert await run(git_rw, "rm -f a.txt") == (0, b"rm 'a.txt'\n", b"")
    assert not (repo_path / "a.txt").exists()


@pytest.mark.asyncio
async def test_quiet_prints_nothing(git_rw):
    assert await run(git_rw, "rm -q b.txt") == (0, b"", b"")


@pytest.mark.asyncio
async def test_no_pathspec_is_fatal(git_rw):
    code, _out, err = await run(git_rw, "rm")
    assert code == 128
    assert err == (b"fatal: No pathspec was given. Which files should I "
                   b"remove?\n")


@pytest.mark.asyncio
async def test_a_directory_is_refused_without_r_and_removed_with_it(
        git_rw, repo_path: Path):
    await git_rw.execute("mkdir /repo/docs && echo x > /repo/docs/one.md")
    await run(git_rw, "add docs")
    await run(git_rw, "commit -m docs")
    code, _out, err = await run(git_rw, "rm docs")
    assert code == 128
    assert err == b"fatal: not removing 'docs' recursively without -r\n"
    assert await run(git_rw, "rm -r docs") == (0, b"rm 'docs/one.md'\n", b"")
    # git removes the directory its last tracked file left empty.
    assert not (repo_path / "docs").exists()


@pytest.mark.asyncio
async def test_a_dashed_pathspec_is_removed_when_the_line_escapes_it(
        git_rw, repo_path: Path):
    (repo_path / "-draft").write_text("x\n", encoding="utf-8")
    await run(git_rw, "add -- -draft")
    await run(git_rw, "commit -m draft")
    assert await run(git_rw, "rm -- -draft") == (0, b"rm '-draft'\n", b"")
    assert not (repo_path / "-draft").exists()


@pytest.mark.asyncio
async def test_a_directory_where_a_tracked_file_was_is_refused(
        git_rw, repo_path: Path):
    # unlink cannot empty a tree, and git reports the strerror rather
    # than removing what it never tracked. The index is written last, so
    # the entry is left staged exactly as it stood.
    await git_rw.execute("rm /repo/b.txt && mkdir /repo/b.txt")
    await git_rw.execute("echo k > /repo/b.txt/keep")
    code, out, err = await run(git_rw, "rm b.txt")
    assert code == 128
    assert err == b"fatal: git rm: 'b.txt': Is a directory\n"
    # git prints the line for every selected path before it deletes
    # anything, so it is printed whether the line goes through or not.
    assert out == b"rm 'b.txt'\n"
    assert (repo_path / "b.txt" / "keep").exists()
    code, out, _err = await run(git_rw, "status --short")
    assert b"D  b.txt" not in out


@pytest.mark.asyncio
async def test_a_deletion_already_made_tolerates_the_refusal(
        git_rw, repo_path: Path):
    # git's own rule: the failure is fatal only while nothing has been
    # deleted yet. a.txt sorts first and goes, so b.txt's failure is
    # swallowed and the whole line succeeds with both entries unstaged.
    await git_rw.execute("rm /repo/b.txt && mkdir /repo/b.txt")
    await git_rw.execute("echo k > /repo/b.txt/keep")
    code, out, err = await run(git_rw, "rm -f a.txt b.txt")
    assert (code, err) == (0, b"")
    assert out == b"rm 'a.txt'\nrm 'b.txt'\n"
    assert not (repo_path / "a.txt").exists()
    assert (repo_path / "b.txt" / "keep").exists()


@pytest.mark.asyncio
async def test_the_refusal_stands_when_nothing_has_gone_yet(
        git_rw, repo_path: Path):
    # The mirror of the test above, with the directory on the path that
    # sorts first: nothing has been deleted when a.txt fails, so the
    # line is fatal and b.txt is never reached. An empty directory
    # refuses the same way, since unlink is the call that cannot make
    # it either.
    await git_rw.execute("rm /repo/a.txt && mkdir /repo/a.txt")
    code, _out, err = await run(git_rw, "rm -f a.txt b.txt")
    assert code == 128
    assert err == b"fatal: git rm: 'a.txt': Is a directory\n"
    assert (repo_path / "b.txt").exists()


@pytest.mark.asyncio
async def test_cached_unstages_a_directory_without_touching_it(
        git_rw, repo_path: Path):
    # --cached deletes nothing, so the refusal never arises: the entry
    # goes and the directory stays.
    await git_rw.execute("rm /repo/b.txt && mkdir /repo/b.txt")
    await git_rw.execute("echo k > /repo/b.txt/keep")
    assert await run(git_rw, "rm --cached b.txt") == (0, b"rm 'b.txt'\n", b"")
    assert (repo_path / "b.txt" / "keep").exists()


@pytest.mark.asyncio
async def test_a_tracked_link_to_a_directory_is_removed_as_a_link(
        git_rw, repo_path: Path):
    # A link is not the directory it points at, and reading it as one
    # would refuse a removal git makes: the namespace is asked first.
    await git_rw.execute("mkdir /repo/real && echo r > /repo/real/child")
    await git_rw.execute("ln -s real /repo/slot")
    await run(git_rw, "add -A")
    await run(git_rw, "commit -m linked")
    assert await run(git_rw, "rm slot") == (0, b"rm 'slot'\n", b"")
    assert (repo_path / "real" / "child").exists()


class Hiding:
    """A link view where ``slot`` is a link and ``slot/child`` is live.

    ``resolve`` is the name plane's own walk, so a path under the link
    comes back respelled; ``exists`` answers through the dispatcher, so
    a target that is not there answers False.
    """

    def __init__(self, present: bool = True) -> None:
        self.present = present

    def resolve(self, path: str) -> str:
        """Where a path really points.

        Args:
            path (str): absolute virtual path.
        """
        if path.startswith("/repo/slot"):
            return path.replace("/repo/slot", "/away", 1)
        return path

    async def exists(self, path: str) -> bool:
        """Whether anything is there once the links are resolved.

        Asked with the path as typed, since the real view resolves for
        itself: that is what lets a link across mounts answer at all.

        Args:
            path (str): absolute virtual path.
        """
        return self.present and self.resolve(path).startswith("/away")


@pytest.mark.asyncio
async def test_a_link_above_a_deleted_path_makes_it_a_local_change():
    hidden = await shadowed(Hiding(), "/repo", ["slot/child"],
                            {"slot/child": DELETED})
    assert hidden == {"slot/child"}


@pytest.mark.asyncio
async def test_a_link_pointing_at_nothing_leaves_the_path_deleted():
    # git lstats through the leading link and gets ENOENT, so there is
    # no local change to lose and the removal goes through.
    hidden = await shadowed(Hiding(present=False), "/repo", ["slot/child"],
                            {"slot/child": DELETED})
    assert hidden == set()


@pytest.mark.asyncio
async def test_a_path_the_walk_found_is_never_shadowed():
    hidden = await shadowed(Hiding(), "/repo", ["slot/child"],
                            {"slot/child": MODIFIED})
    assert hidden == set()


@pytest.mark.asyncio
async def test_without_a_namespace_nothing_is_shadowed():
    assert await shadowed(None, "/repo", ["slot/child"],
                          {"slot/child": DELETED}) == set()


@pytest.mark.asyncio
async def test_a_tracked_path_behind_a_link_is_refused_as_a_local_change(
        git_rw, repo_path: Path):
    # The walk lstats, so the link hides the tracked file and the path
    # reads as deleted, which is what git's own status says too. git
    # rm does not read it that way: its lstat resolves the leading
    # component and finds another file entirely.
    await git_rw.execute("mkdir /repo/slot && echo t > /repo/slot/child")
    await git_rw.execute("mkdir /repo/away && echo o > /repo/away/child")
    await run(git_rw, "add slot/child")
    await run(git_rw, "commit -m slotted")
    await git_rw.execute("rm -rf /repo/slot")
    await git_rw.execute("ln -s /repo/away /repo/slot")
    assert await run(git_rw, "status --short") == (0, b" D slot/child\n"
                                                   b"?? away/\n?? slot\n", b"")
    code, _out, err = await run(git_rw, "rm slot/child")
    assert code == 1
    assert err == (b"error: the following file has local modifications:\n"
                   b"    slot/child\n"
                   b"(use --cached to keep the file, or -f to force "
                   b"removal)\n")
    assert (repo_path / "away" / "child").exists()


@pytest.mark.asyncio
async def test_a_link_pointing_past_the_tracked_path_removes_it(
        git_rw, repo_path: Path):
    # Nothing at the other end, so git has nothing to lose and stages
    # the deletion.
    await git_rw.execute("mkdir /repo/slot && echo t > /repo/slot/child")
    await git_rw.execute("mkdir /repo/away")
    await run(git_rw, "add slot/child")
    await run(git_rw, "commit -m slotted")
    await git_rw.execute("rm -rf /repo/slot")
    await git_rw.execute("ln -s /repo/away /repo/slot")
    assert await run(git_rw, "rm slot/child") == (0, b"rm 'slot/child'\n", b"")


@pytest.mark.asyncio
async def test_cached_keeps_the_file_a_link_hides(git_rw):
    await git_rw.execute("mkdir /repo/slot && echo t > /repo/slot/child")
    await git_rw.execute("mkdir /repo/away && echo o > /repo/away/child")
    await run(git_rw, "add slot/child")
    await run(git_rw, "commit -m slotted")
    await git_rw.execute("rm -rf /repo/slot")
    await git_rw.execute("ln -s /repo/away /repo/slot")
    assert await run(git_rw,
                     "rm --cached slot/child") == (0, b"rm 'slot/child'\n",
                                                   b"")
