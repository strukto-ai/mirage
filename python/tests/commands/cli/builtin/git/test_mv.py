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
from mirage.commands.cli.builtin.git.mv import Move, moved_path, parse_flags
from mirage.commands.spec.flag_view import FlagView
from mirage.types import MountMode
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.commands.cli.builtin.git.conftest import MOUNT, conflict_index


async def run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.shell(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def test_dry_run_implies_verbose():
    parsed = parse_flags(FlagView({"dry_run": True}))
    assert parsed.dry_run and parsed.verbose


def test_a_file_lands_at_its_destination():
    move = Move("a.txt", "b/c.txt", ("a.txt", ), False)
    assert moved_path(move, "a.txt") == "b/c.txt"


def test_a_directory_keeps_the_path_below_it():
    move = Move("docs", "notes", ("docs/one.md", "docs/sub/two.md"), True)
    assert moved_path(move, "docs/sub/two.md") == "notes/sub/two.md"


@pytest.mark.asyncio
async def test_mv_renames_and_stages_the_rename(git_rw, repo_path: Path):
    assert await run(git_rw, "mv a.txt c.txt") == (0, b"", b"")
    assert (repo_path / "c.txt").exists()
    assert not (repo_path / "a.txt").exists()
    assert (await run(git_rw,
                      "status --porcelain"))[1] == b"R  a.txt -> c.txt\n"


@pytest.mark.asyncio
async def test_verbose_names_the_move(git_rw):
    assert await run(git_rw, "mv -v a.txt c.txt") == (0, b"Renaming a.txt to "
                                                      b"c.txt\n", b"")


@pytest.mark.asyncio
async def test_a_missing_source_is_fatal(git_rw):
    code, _out, err = await run(git_rw, "mv nosuch c.txt")
    assert code == 128
    assert err == b"fatal: bad source, source=nosuch, destination=c.txt\n"


@pytest.mark.asyncio
async def test_an_untracked_source_is_fatal(git_rw):
    await git_rw.shell("echo u > /repo/u.txt")
    _code, _out, err = await run(git_rw, "mv u.txt c.txt")
    assert err == (b"fatal: not under version control, source=u.txt, "
                   b"destination=c.txt\n")


@pytest.mark.asyncio
async def test_an_existing_destination_is_refused_unless_forced(
        git_rw, repo_path: Path):
    _code, _out, err = await run(git_rw, "mv a.txt b.txt")
    assert err == (b"fatal: destination exists, source=a.txt, "
                   b"destination=b.txt\n")
    assert await run(git_rw, "mv -f a.txt b.txt") == (0, b"", b"")
    assert (repo_path / "b.txt").read_text() == "one changed\n"
    assert (await run(git_rw, "status --porcelain"))[1] == (b"D  a.txt\n"
                                                            b"M  b.txt\n")


@pytest.mark.asyncio
async def test_a_directory_destination_takes_the_basename(git_rw):
    await git_rw.shell("mkdir /repo/into")
    await run(git_rw, "mv a.txt into")
    assert (await run(git_rw,
                      "status --porcelain"))[1] == b"R  a.txt -> into/a.txt\n"


@pytest.mark.asyncio
async def test_several_sources_need_a_directory(git_rw):
    _code, _out, err = await run(git_rw, "mv a.txt b.txt nowhere")
    assert err == b"fatal: destination 'nowhere' is not a directory\n"


@pytest.mark.asyncio
async def test_a_directory_moves_with_everything_under_it(
        git_rw, repo_path: Path):
    await git_rw.shell("mkdir /repo/docs && echo x > /repo/docs/one.md")
    await run(git_rw, "add docs")
    await run(git_rw, "commit -m docs")
    await git_rw.shell("echo u > /repo/docs/untracked.md")
    assert await run(git_rw, "mv docs notes") == (0, b"", b"")
    assert (repo_path / "notes" / "untracked.md").exists()
    assert (await run(git_rw, "status --porcelain"))[1] == (
        b"R  docs/one.md -> notes/one.md\n?? notes/untracked.md\n")


@pytest.mark.asyncio
async def test_one_operand_prints_the_usage(git_rw):
    code, _out, err = await run(git_rw, "mv a.txt")
    assert code == 129
    assert err.startswith(b"usage: git mv [-v] [-f] [-n] [-k] <source> "
                          b"<destination>\n")


@pytest.mark.asyncio
async def test_dry_run_moves_nothing(git_rw, repo_path: Path):
    code, out, _err = await run(git_rw, "mv -n a.txt c.txt")
    assert code == 0
    assert out == (b"Checking rename of 'a.txt' to 'c.txt'\n"
                   b"Renaming a.txt to c.txt\n")
    assert (repo_path / "a.txt").exists()


@pytest.mark.asyncio
async def test_k_skips_a_source_that_cannot_move(git_rw):
    assert await run(git_rw, "mv -k nosuch c.txt") == (0, b"", b"")


@pytest.mark.asyncio
async def test_a_missing_destination_directory_is_the_renames_failure(git_rw):
    code, _out, err = await run(git_rw, "mv a.txt nodir/c.txt")
    assert code == 128
    assert err == (b"fatal: renaming 'a.txt' failed: No such file or "
                   b"directory\n")


@pytest.mark.asyncio
async def test_two_sources_cannot_land_on_one_name(git_rw, repo_path: Path):
    await git_rw.shell("mkdir -p /repo/a /repo/b /repo/dest")
    await git_rw.shell("echo ax > /repo/a/x && echo bx > /repo/b/x")
    await run(git_rw, "add a b")
    await run(git_rw, "commit -m two")
    code, _out, err = await run(git_rw, "mv a/x b/x dest")
    assert code == 128
    assert err == (b"fatal: multiple sources for the same target, "
                   b"source=b/x, destination=dest/x\n")
    assert (repo_path / "a" / "x").exists()
    assert not (repo_path / "dest" / "x").exists()


@pytest.mark.asyncio
async def test_two_directories_collide_at_the_path_that_collides(git_rw):
    await git_rw.shell("mkdir -p /repo/a/sub /repo/b/sub /repo/dest")
    await git_rw.shell("echo 1 > /repo/a/sub/f && echo 2 > /repo/b/sub/f")
    await run(git_rw, "add a b")
    await run(git_rw, "commit -m dirs")
    _code, _out, err = await run(git_rw, "mv a/sub b/sub dest")
    assert err == (b"fatal: multiple sources for the same target, "
                   b"source=b/sub/f, destination=dest/sub/f\n")


@pytest.mark.asyncio
async def test_a_sources_own_fault_outranks_the_collision(git_rw):
    await git_rw.shell("mkdir -p /repo/a /repo/b /repo/dest")
    await git_rw.shell("echo ax > /repo/a/x && echo bx > /repo/b/x")
    await run(git_rw, "add a")
    await run(git_rw, "commit -m one")
    _code, _out, err = await run(git_rw, "mv a/x b/x dest")
    assert err == (b"fatal: not under version control, source=b/x, "
                   b"destination=dest/x\n")


@pytest.mark.asyncio
async def test_k_skips_the_source_that_would_collide(git_rw, repo_path: Path):
    await git_rw.shell("mkdir -p /repo/a /repo/b /repo/dest")
    await git_rw.shell("echo ax > /repo/a/x && echo bx > /repo/b/x")
    await run(git_rw, "add a b")
    await run(git_rw, "commit -m two")
    assert await run(git_rw, "mv -k a/x b/x dest") == (0, b"", b"")
    assert (repo_path / "dest" / "x").read_text() == "ax\n"
    assert (repo_path / "b" / "x").exists()


@pytest.mark.asyncio
async def test_a_conflicted_source_is_refused(git_rw, repo_path: Path):
    conflict_index(repo_path, "a.txt")
    code, _out, err = await run(git_rw, "mv a.txt c.txt")
    assert code == 128
    assert err == b"fatal: conflicted, source=a.txt, destination=c.txt\n"
    assert (repo_path / "a.txt").exists()


@pytest.mark.asyncio
async def test_a_conflicted_source_outranks_an_occupied_destination(
        git_rw, repo_path: Path):
    conflict_index(repo_path, "a.txt")
    _code, _out, err = await run(git_rw, "mv a.txt b.txt")
    assert err == b"fatal: conflicted, source=a.txt, destination=b.txt\n"


@pytest.mark.asyncio
async def test_a_directory_holding_a_conflict_is_refused_by_that_path(
        git_rw, repo_path: Path):
    await git_rw.shell("mkdir /repo/docs && echo x > /repo/docs/one.md")
    await run(git_rw, "add docs")
    await run(git_rw, "commit -m docs")
    conflict_index(repo_path, "docs/one.md")
    code, _out, err = await run(git_rw, "mv docs notes")
    assert code == 128
    assert err == (b"fatal: conflicted, source=docs/one.md, "
                   b"destination=notes/one.md\n")
    assert (repo_path / "docs" / "one.md").exists()
    assert not (repo_path / "notes").exists()


@pytest.mark.asyncio
async def test_k_skips_a_conflicted_source(git_rw, repo_path: Path):
    conflict_index(repo_path, "a.txt")
    assert await run(git_rw, "mv -k a.txt c.txt") == (0, b"", b"")
    assert (repo_path / "a.txt").exists()


@pytest.mark.asyncio
async def test_a_directory_carries_its_symlinks(git_rw):
    await git_rw.shell("mkdir /repo/docs && echo x > /repo/docs/one.md")
    await git_rw.shell("ln -s one.md /repo/docs/link")
    await run(git_rw, "add docs")
    await run(git_rw, "commit -m docs")
    assert await run(git_rw, "mv docs notes") == (0, b"", b"")
    # The link lives in the namespace, not on the disk the mount serves,
    # so it is read back through the workspace rather than off the path.
    moved = await git_rw.shell("readlink /repo/notes/link")
    left = await git_rw.shell("readlink /repo/docs/link")
    assert moved.stdout == b"one.md\n"
    assert left.exit_code != 0
    assert (await run(git_rw, "status --porcelain"))[1] == (
        b"R  docs/link -> notes/link\nR  docs/one.md -> notes/one.md\n")


@pytest.mark.asyncio
async def test_a_directory_holding_a_mount_will_not_move(repo_path: Path):
    with Workspace(
        {
            MOUNT: DiskVFS(root=str(repo_path)),
            "/repo/docs/inner/": RAMVFS(),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir -p /repo/docs && echo x > /repo/docs/one.md")
        await run(ws, "add docs")
        code, _out, err = await run(ws, "mv docs notes")
        assert code == 128
        assert err == (b"fatal: renaming 'docs' failed: Device or resource "
                       b"busy\n")
        assert (repo_path / "docs" / "one.md").exists()
        assert not (repo_path / "notes").exists()


@pytest.mark.asyncio
async def test_a_mount_root_itself_will_not_move(repo_path: Path):
    with Workspace(
        {
            MOUNT: DiskVFS(root=str(repo_path)),
            "/repo/inner/": RAMVFS(),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("echo x > /repo/inner/one.md")
        await run(ws, "add inner")
        code, _out, err = await run(ws, "mv inner elsewhere")
        assert code == 128
        assert err == (b"fatal: renaming 'inner' failed: Device or resource "
                       b"busy\n")


@pytest.mark.asyncio
async def test_a_file_will_not_move_into_another_mount(repo_path: Path):
    # The source is an ordinary tracked file, so neither "is a mount
    # root" nor "holds one" catches it. The rename op binds to the
    # backend serving the source, so the write would land in the
    # repository's own mount at a path the inner one serves: the file
    # ends up hidden behind that mount while the index names the new
    # path.
    with Workspace(
        {
            MOUNT: DiskVFS(root=str(repo_path)),
            "/repo/inner/": RAMVFS(),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("echo x > /repo/one.md")
        await run(ws, "add one.md")
        code, _out, err = await run(ws, "mv one.md inner/one.md")
        assert code == 128
        assert err == (b"fatal: renaming 'one.md' failed: Device or resource "
                       b"busy\n")
        assert (repo_path / "one.md").exists()


@pytest.mark.asyncio
async def test_a_file_will_not_move_out_of_a_nested_mount(repo_path: Path):
    with Workspace(
        {
            MOUNT: DiskVFS(root=str(repo_path)),
            "/repo/inner/": RAMVFS(),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("echo x > /repo/inner/one.md")
        await run(ws, "add inner/one.md")
        code, _out, err = await run(ws, "mv inner/one.md one.md")
        assert code == 128
        assert err == (b"fatal: renaming 'inner/one.md' failed: Device or "
                       b"resource busy\n")


@pytest.mark.asyncio
async def test_a_move_inside_one_mount_still_goes(repo_path: Path):
    # The destination check compares the two ends, so an ordinary move
    # that never leaves the repository's own mount is untouched by it.
    with Workspace(
        {
            MOUNT: DiskVFS(root=str(repo_path)),
            "/repo/inner/": RAMVFS(),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir -p /repo/docs && echo x > /repo/one.md")
        await run(ws, "add one.md")
        assert await run(ws, "mv one.md docs/one.md") == (0, b"", b"")
        assert (repo_path / "docs" / "one.md").exists()


@pytest.mark.asyncio
async def test_k_skips_a_source_that_holds_a_mount(repo_path: Path):
    with Workspace(
        {
            MOUNT: DiskVFS(root=str(repo_path)),
            "/repo/docs/inner/": RAMVFS(),
        },
            mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        await ws.shell("mkdir -p /repo/docs && echo x > /repo/docs/one.md")
        await run(ws, "add docs")
        assert await run(ws, "mv -k docs notes") == (0, b"", b"")
        assert (repo_path / "docs" / "one.md").exists()


@pytest.mark.asyncio
async def test_a_dashed_pathspec_moves_when_the_line_escapes_it(
        git_rw, repo_path: Path):
    (repo_path / "-draft").write_text("x\n", encoding="utf-8")
    await run(git_rw, "add -- -draft")
    assert await run(git_rw, "mv -- -draft kept.txt") == (0, b"", b"")
    assert (repo_path / "kept.txt").read_text() == "x\n"
    assert not (repo_path / "-draft").exists()


@pytest.mark.asyncio
async def test_a_dashed_operand_is_still_a_switch_unescaped(git_rw):
    # Named the way parse-options does: the first letter mv does not
    # know, `d', not the whole word (git 2.50.1).
    code, _out, err = await run(git_rw, "mv -draft kept.txt")
    assert code == 129
    assert err == b"error: unknown switch `d'\n"


@pytest.mark.asyncio
async def test_a_cluster_is_refused_past_the_switches_mv_knows(git_rw):
    code, _out, err = await run(git_rw, "mv -nx kept.txt other.txt")
    assert code == 129
    assert err == b"error: unknown switch `x'\n"


@pytest.mark.asyncio
async def test_the_overlay_travels_with_a_moved_file(git_rw):
    # git mv renames through the dispatcher, which is where the node
    # table's own bookkeeping lives. A mode the inode cannot hold is
    # recorded in the namespace overlay, and leaving it at the emptied
    # name both lost it at the landing and left it to be inherited by
    # whatever was written at the old name next.
    assert (await git_rw.shell("chmod 400 /repo/a.txt")).exit_code == 0
    assert await run(git_rw, "mv a.txt c.txt") == (0, b"", b"")
    listed = await git_rw.shell("ls -l /repo/c.txt")
    assert (listed.stdout or b"").startswith(b"-r--------")
    assert git_rw.namespace.meta_for("/repo/a.txt") is None


@pytest.mark.asyncio
async def test_a_link_below_a_moved_directory_travels_too(git_rw):
    await git_rw.shell("mkdir -p /repo/d && echo t > /repo/t.txt")
    await git_rw.shell("ln -s /repo/t.txt /repo/d/link")
    assert (await run(git_rw, "add d"))[0] == 0
    assert await run(git_rw, "mv d notes") == (0, b"", b"")
    read = await git_rw.shell("readlink /repo/notes/link")
    assert (read.exit_code, read.stdout) == (0, b"/repo/t.txt\n")


@pytest.mark.asyncio
async def test_a_directory_and_something_inside_it_cannot_both_move(
        git_rw, repo_path: Path):
    await git_rw.shell("mkdir -p /repo/dir /repo/dest")
    await git_rw.shell("echo z > /repo/dir/file")
    await run(git_rw, "add dir")
    await run(git_rw, "commit -m dir")
    code, _out, err = await run(git_rw, "mv dir dir/file dest")
    assert code == 128
    assert err == (b"fatal: cannot move both 'dir/file' and its parent "
                   b"directory 'dir'\n")
    # Refused before anything moves, which is the whole point: moving
    # the directory first is what makes the other source disappear.
    assert (repo_path / "dir" / "file").exists()
    assert not (repo_path / "dest" / "dir").exists()


@pytest.mark.asyncio
async def test_the_child_is_named_first_whatever_the_order(git_rw):
    await git_rw.shell("mkdir -p /repo/dir /repo/dest")
    await git_rw.shell("echo z > /repo/dir/file")
    await run(git_rw, "add dir")
    await run(git_rw, "commit -m dir")
    _code, _out, err = await run(git_rw, "mv dir/file dir dest")
    assert err == (b"fatal: cannot move both 'dir/file' and its parent "
                   b"directory 'dir'\n")


@pytest.mark.asyncio
async def test_k_does_not_skip_an_overlapping_source(git_rw, repo_path: Path):
    await git_rw.shell("mkdir -p /repo/dir /repo/dest")
    await git_rw.shell("echo z > /repo/dir/file")
    await run(git_rw, "add dir")
    await run(git_rw, "commit -m dir")
    code, _out, err = await run(git_rw, "mv -k dir dir/file dest")
    assert code == 128
    assert err == (b"fatal: cannot move both 'dir/file' and its parent "
                   b"directory 'dir'\n")
    assert (repo_path / "dir" / "file").exists()


@pytest.mark.asyncio
async def test_a_sources_own_fault_outranks_the_overlap(git_rw):
    await git_rw.shell("mkdir -p /repo/dir /repo/dest")
    await git_rw.shell("echo z > /repo/dir/file")
    await run(git_rw, "add dir")
    await run(git_rw, "commit -m dir")
    # The overlap is read off the whole line once every source has
    # passed its own checks, so a later bad source is reported first.
    _code, _out, err = await run(git_rw, "mv dir dir/file nosuch dest")
    assert err == (b"fatal: bad source, source=nosuch, "
                   b"destination=dest/nosuch\n")


@pytest.mark.asyncio
async def test_k_taking_a_source_out_takes_it_out_of_the_overlap(
        git_rw, repo_path: Path):
    await git_rw.shell("mkdir -p /repo/dir /repo/dest")
    await git_rw.shell("echo z > /repo/dir/file")
    await run(git_rw, "add dir")
    await run(git_rw, "commit -m dir")
    await git_rw.shell("echo o > /repo/dir/other")
    # ``dir/other`` is untracked, so it is skipped before the overlap
    # is looked at and the directory moves on its own.
    assert await run(git_rw, "mv -k dir dir/other dest") == (0, b"", b"")
    assert (repo_path / "dest" / "dir" / "file").exists()


@pytest.mark.asyncio
async def test_f_takes_the_destinations_conflict_stages_with_it(
        repo_path: Path):
    # -f is the only way to reach an occupied destination, and git's
    # answer there is one stage-0 entry holding the source: ls-files -u
    # is empty afterwards. Leaving the stages is the worse divergence,
    # since write_index lays them back over the entry and the moved
    # blob is the copy that disappears.
    conflict_index(repo_path, "b.txt")
    with Workspace({MOUNT: DiskVFS(root=str(repo_path))},
                   mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        assert (await run(ws, "status --short"))[1].startswith(b"UU b.txt\n")
        assert await run(ws, "mv -f a.txt b.txt") == (0, b"", b"")
        assert (await run(ws, "status --short"))[1] == (b"D  a.txt\n"
                                                        b"M  b.txt\n")
    assert (repo_path / "b.txt").read_text(encoding="utf-8") == "one changed\n"
    assert not (repo_path / "a.txt").exists()
