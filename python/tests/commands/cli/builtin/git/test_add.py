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

import subprocess
from pathlib import Path

import pytest
from dulwich.objects import Blob
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git.add import (
    EXECUTABLE,
    REGULAR,
    SYMLINK,
    entry_mode,
    keep_addable,
    staged_entry,
)
from mirage.commands.cli.builtin.git.ignore import IgnoreStack
from mirage.policy import Deny, Policy, VfsContext
from mirage.types import LINK_TARGET_KEY, ContentType, FileStat, FileType


def stat(mode: int | None) -> FileStat:
    """What a mount reports about one file.

    Args:
        mode (int | None): permission bits, None when it has none.
    """
    return FileStat(
        name="x",
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=4,
        mode=mode,
    )


async def run(git_rw, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        git_rw (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await git_rw.shell(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def staged(repo_path: Path) -> dict[bytes, bytes]:
    """The index as the real dulwich reader sees it.

    Read back with a plain on-disk repository rather than through
    mirage, so what is asserted is that the bytes mirage wrote are a
    valid index, not that mirage agrees with itself.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Repo(str(repo_path)) as repo:
        return {path: entry.sha for path, entry in repo.open_index().items()}


def test_an_ordinary_file_stages_as_644():
    assert entry_mode(stat(0o644)) == REGULAR


def test_an_executable_file_stages_as_755():
    assert entry_mode(stat(0o755)) == EXECUTABLE


def test_only_the_owner_execute_bit_counts():
    # git reads S_IXUSR and nothing else, so a file executable by
    # others alone is still an ordinary one.
    assert entry_mode(stat(0o645)) == REGULAR


def test_a_mount_with_no_modes_stages_the_ordinary_one():
    assert entry_mode(stat(None)) == REGULAR


def test_a_staged_entry_zeroes_the_stat_cache():
    # git reads a zeroed entry as one whose cache it should not trust,
    # which is right: a mount serves none of these meaningfully, and a
    # wrong value would be trusted.
    entry = staged_entry(b"a" * 40, stat(0o644), 12)
    assert (entry.ctime, entry.mtime, entry.dev, entry.ino) == (0, 0, 0, 0)
    assert entry.size == 12


def test_an_ignored_path_is_dropped():
    ignores = IgnoreStack([]).push("", b"*.log\n")
    assert keep_addable({"a.log", "b.txt"}, set(), ignores) == {"b.txt"}


def test_a_tracked_path_survives_its_own_ignore_rule():
    # Ignore rules govern untracked files only, so a file already in the
    # index stays stageable however the rules read.
    ignores = IgnoreStack([]).push("", b"*.log\n")
    assert keep_addable({"a.log"}, {"a.log"}, ignores) == {"a.log"}


@pytest.mark.asyncio
async def test_staging_writes_a_blob_the_real_git_can_read(
    git_rw, repo_path: Path
):
    (repo_path / "a.txt").write_text("staged content\n", encoding="utf-8")
    assert await run(git_rw, "add a.txt") == (0, b"", b"")
    expected = Blob.from_string(b"staged content\n").id
    assert staged(repo_path)[b"a.txt"] == expected


@pytest.mark.asyncio
async def test_staging_a_new_file_adds_it_to_the_index(
    git_rw, repo_path: Path
):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    await run(git_rw, "add fresh.txt")
    assert b"fresh.txt" in staged(repo_path)


@pytest.mark.asyncio
async def test_staging_a_removed_file_records_the_removal(
    git_rw, repo_path: Path
):
    (repo_path / "b.txt").unlink()
    await run(git_rw, "add b.txt")
    assert b"b.txt" not in staged(repo_path)


@pytest.mark.asyncio
async def test_all_stages_every_change_at_once(git_rw, repo_path: Path):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    (repo_path / "b.txt").unlink()
    await run(git_rw, "add -A")
    index = staged(repo_path)
    assert b"fresh.txt" in index
    assert b"b.txt" not in index


@pytest.mark.asyncio
async def test_update_leaves_a_new_file_alone(git_rw, repo_path: Path):
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    await run(git_rw, "add -u")
    assert b"fresh.txt" not in staged(repo_path)


@pytest.mark.asyncio
async def test_update_stages_only_what_the_pathspec_covers(
    git_rw, repo_path: Path
):
    # Without the pathspec this restages every tracked file, which is
    # how an unrelated edit ends up in the next commit.
    (repo_path / "a.txt").write_text("edited a\n", encoding="utf-8")
    (repo_path / "b.txt").write_text("edited b\n", encoding="utf-8")
    assert await run(git_rw, "add -u a.txt") == (0, b"", b"")
    index = staged(repo_path)
    assert index[b"a.txt"] == Blob.from_string(b"edited a\n").id
    assert index[b"b.txt"] != Blob.from_string(b"edited b\n").id


@pytest.mark.asyncio
async def test_update_stages_a_removal_only_under_the_pathspec(
    git_rw, repo_path: Path
):
    (repo_path / "a.txt").unlink()
    (repo_path / "b.txt").unlink()
    await run(git_rw, "add -u b.txt")
    index = staged(repo_path)
    assert b"a.txt" in index
    assert b"b.txt" not in index


@pytest.mark.asyncio
async def test_update_with_a_pathspec_that_names_nothing(git_rw):
    code, _out, err = await run(git_rw, "add -u nosuch")
    assert code == 128
    assert err == b"fatal: pathspec 'nosuch' did not match any files\n"


@pytest.mark.asyncio
async def test_update_naming_an_untracked_file_is_refused(
    git_rw, repo_path: Path
):
    # It is there, so the pathspec is not the problem: -u restages what
    # the index holds, and the index has never heard of this one.
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    code, _out, err = await run(git_rw, "add -u fresh.txt")
    assert code == 128
    assert err == (
        b"error: pathspec 'fresh.txt' did not match any file(s) known to git\n"
    )
    assert b"fresh.txt" not in staged(repo_path)


@pytest.mark.asyncio
async def test_a_directory_operand_stages_what_is_under_it(
    git_rw, repo_path: Path
):
    (repo_path / "sub").mkdir()
    (repo_path / "sub" / "one.txt").write_text("x\n", encoding="utf-8")
    await run(git_rw, "add sub")
    assert b"sub/one.txt" in staged(repo_path)


@pytest.mark.asyncio
async def test_a_pathspec_matching_nothing_is_gits_fatal(git_rw):
    code, _out, err = await run(git_rw, "add nosuchfile.txt")
    assert code == 128
    assert err == (
        b"fatal: pathspec 'nosuchfile.txt' did not match any files\n"
    )


@pytest.mark.asyncio
async def test_naming_an_ignored_path_is_refused(git_rw, repo_path: Path):
    (repo_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    (repo_path / "noisy.log").write_text("x\n", encoding="utf-8")
    code, _out, err = await run(git_rw, "add noisy.log")
    assert code == 1
    assert err.startswith(b"The following paths are ignored")
    assert b"noisy.log" not in staged(repo_path)


@pytest.mark.asyncio
async def test_force_stages_it_anyway(git_rw, repo_path: Path):
    (repo_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    (repo_path / "noisy.log").write_text("x\n", encoding="utf-8")
    assert (await run(git_rw, "add -f noisy.log"))[0] == 0
    assert b"noisy.log" in staged(repo_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["add -f .", "add -A -f"])
async def test_force_stages_what_an_ignored_directory_holds(
    git_rw, repo_path: Path, line
):
    (repo_path / ".gitignore").write_text("build/\n*.log\n", encoding="utf-8")
    (repo_path / "build").mkdir()
    (repo_path / "build" / "out.o").write_text("x\n", encoding="utf-8")
    (repo_path / "build" / "lib" / ".git").mkdir(parents=True)
    (repo_path / "build" / "lib" / ".git" / "HEAD").write_text(
        "ref: refs/heads/main\n", encoding="utf-8"
    )
    (repo_path / "noisy.log").write_text("x\n", encoding="utf-8")
    assert (await run(git_rw, line))[0] == 0
    index = staged(repo_path)
    assert b"build/out.o" in index
    assert b"noisy.log" in index
    assert not [path for path in index if b".git/" in path]


@pytest.mark.asyncio
async def test_a_directory_operand_skips_the_ignored_ones_quietly(
    git_rw, repo_path: Path
):
    # Asking for a directory is not asking for the things in it that
    # were excluded, so this is not the refusal above.
    (repo_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    (repo_path / "noisy.log").write_text("x\n", encoding="utf-8")
    (repo_path / "keep.txt").write_text("x\n", encoding="utf-8")
    assert (await run(git_rw, "add ."))[0] == 0
    index = staged(repo_path)
    assert b"keep.txt" in index
    assert b"noisy.log" not in index


@pytest.mark.asyncio
async def test_no_pathspec_says_so_and_exits_zero(git_rw):
    code, _out, err = await run(git_rw, "add")
    assert code == 0
    assert err.startswith(b"Nothing specified, nothing added.")


@pytest.mark.asyncio
async def test_staging_twice_is_not_an_error(git_rw, repo_path: Path):
    # The second pass rewrites an object that already exists, and git
    # writes loose objects read-only, so a blind write fails with EACCES.
    (repo_path / "a.txt").write_text("twice\n", encoding="utf-8")
    assert (await run(git_rw, "add -A"))[0] == 0
    assert (await run(git_rw, "add -A")) == (0, b"", b"")


def link_stat(target: str) -> FileStat:
    """What the name plane reports about a symlink.

    Args:
        target (str): the link's target, verbatim as it was typed.
    """
    return FileStat(
        name="link",
        type=FileType.SYMLINK,
        size=len(target),
        extra={LINK_TARGET_KEY: target},
    )


def test_a_symlink_stages_as_120000():
    assert entry_mode(link_stat("a.txt")) == SYMLINK


@pytest.mark.asyncio
async def test_a_symlink_stages_its_target_not_the_target_content(
    git_rw, repo_path: Path
):
    # Pinned against git 2.50: the blob is the target string and the
    # mode is 120000. Reading through the link would store `one\n` under
    # mode 100644, which is a second copy of a.txt, not a link.
    await git_rw.shell("ln -s a.txt /repo/link")
    assert (await run(git_rw, "add link"))[0] == 0
    with Repo(str(repo_path)) as repo:
        entry = repo.open_index()[b"link"]
        assert entry.mode == SYMLINK
        assert repo.object_store[entry.sha].data == b"a.txt"


@pytest.mark.asyncio
async def test_a_broken_symlink_stages_its_target(git_rw, repo_path: Path):
    # git stores the target string whether or not anything is there, so
    # a link to nothing stages exactly like a live one.
    await git_rw.shell("ln -s nowhere /repo/broken")
    assert (await run(git_rw, "add broken"))[0] == 0
    with Repo(str(repo_path)) as repo:
        entry = repo.open_index()[b"broken"]
        assert entry.mode == SYMLINK
        assert repo.object_store[entry.sha].data == b"nowhere"


@pytest.mark.asyncio
async def test_a_staged_symlink_is_not_reported_modified(git_rw):
    # The staged blob is the target string; comparing it against the
    # bytes behind the link would call every symlink modified.
    await git_rw.shell("ln -s a.txt /repo/link")
    assert (await run(git_rw, "add link"))[0] == 0
    _code, out, _err = await run(git_rw, "status --porcelain")
    assert out == b"A  link\n"


@pytest.mark.asyncio
async def test_verbose_names_each_change_in_gits_order(
    git_rw, repo_path: Path
):
    # Paths the index already held come first, in index order and a
    # removal among them, then new ones; pinned against git 2.50.
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    (repo_path / "b.txt").unlink()
    (repo_path / "aa.txt").write_text("new\n", encoding="utf-8")
    assert await run(git_rw, "add -v -A") == (
        0,
        b"add 'a.txt'\nremove 'b.txt'\nadd 'aa.txt'\n",
        b"",
    )


@pytest.mark.asyncio
async def test_verbose_names_nothing_restaged_unchanged(
    git_rw, repo_path: Path
):
    (repo_path / "a.txt").write_text("edited\n", encoding="utf-8")
    await run(git_rw, "add a.txt")
    assert await run(git_rw, "add --verbose a.txt") == (0, b"", b"")


class _Sealed(Policy):
    def __init__(self, path: str) -> None:
        self.path = path

    async def pre_vfs(self, ctx: VfsContext) -> Deny | None:
        sealed = ctx.call.name == "read" and ctx.path.virtual == self.path
        return Deny("sealed") if sealed else None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name, verb", [("a.txt", "updating"), ("fresh.txt", "adding")]
)
async def test_an_unreadable_file_is_refused_in_git_words(
    git_rw, repo_path: Path, name: str, verb: str
):
    (repo_path / name).write_text("new\n", encoding="utf-8")
    git_rw._registry.policies.add(_Sealed(f"/repo/{name}"))
    assert await run(git_rw, f"add {name}") == (
        128,
        b"",
        f'error: open("{name}"): Permission denied\n'
        f"error: unable to index file '{name}'\n"
        f"fatal: {verb} files failed\n".encode(),
    )


@pytest.mark.asyncio
async def test_a_rooted_path_after_top_magic_reads_nothing_outside(
    git_parent, repo_path: Path
):
    (repo_path.parent / "secret.txt").write_bytes(b"S3CR3T\n")
    result = await git_parent.shell(
        "cd /w/work && git add -- ':/:/w/secret.txt'"
    )
    assert result.exit_code == 128
    assert b"is outside repository" in result.stderr
    with Repo(str(repo_path)) as repo:
        assert Blob.from_string(b"S3CR3T\n").id not in repo.object_store


def _embedded(root: Path, checked_out: bool = True) -> str:
    """A repository of its own at ``root/sub`` with one commit, or with
    HEAD on a branch that has none yet when told so; that commit."""
    sub = root / "sub"
    sub.mkdir()
    subprocess.run(["git", "-C", str(sub), "init", "-q"], check=True)
    (sub / "in.txt").write_text("inner\n", encoding="utf-8")
    git = ["git", "-C", str(sub), "-c", "user.name=a", "-c", "user.email=a@b"]
    subprocess.run([*git, "add", "."], check=True)
    subprocess.run([*git, "commit", "-qm", "inner"], check=True)
    head = subprocess.run(
        [*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if not checked_out:
        subprocess.run(
            [*git, "checkout", "-q", "--orphan", "unborn"], check=True
        )
    return head


@pytest.mark.asyncio
async def test_an_embedded_repository_stages_as_a_gitlink(
    git_rw, repo_path: Path
):
    # git 2.47.3: the repository's HEAD commit at mode 160000, never its
    # files, and the warning with its advice on stderr.
    head = _embedded(repo_path)
    code, _out, err = await run(git_rw, "add -A")
    assert code == 0
    assert err.startswith(
        b"warning: adding embedded git repository: sub\n"
        b"hint: You've added another git repository inside your current "
        b"repository.\n"
    )
    index = staged(repo_path)
    assert index[b"sub"] == head.encode()
    assert not [path for path in index if path.startswith(b"sub/")]
    code, _out, err = await run(git_rw, "add sub/in.txt")
    assert (code, err) == (
        128,
        b"fatal: Pathspec 'sub/in.txt' is in submodule 'sub'\n",
    )
    (repo_path / "sub" / "in.txt").write_text("more\n", encoding="utf-8")
    code, out, _err = await run(git_rw, "status")
    assert b"\tnew file:   sub\n" in out
    assert b"\tmodified:   sub (modified content)\n" in out


@pytest.mark.asyncio
async def test_an_embedded_repository_without_a_commit_is_refused(
    git_rw, repo_path: Path
):
    _embedded(repo_path, checked_out=False)
    (repo_path / "fresh.txt").write_text("x\n", encoding="utf-8")
    code, _out, err = await run(git_rw, "add -A")
    assert (code, err) == (
        128,
        b"error: 'sub/' does not have a commit checked out\n"
        b"fatal: adding files failed\n",
    )
    assert b"fresh.txt" not in staged(repo_path)


@pytest.mark.asyncio
async def test_short_status_names_what_changed_in_a_gitlink(
    git_rw, repo_path: Path
):
    # git 2.47.3: ``m`` for modified content and ``?`` for untracked
    # content alone in short status, ``M`` in porcelain; a gitlink whose
    # directory is gone is staged as deleted.
    _embedded(repo_path)
    assert (await run(git_rw, "add -A"))[0] == 0
    assert (await run(git_rw, "commit -qm sub"))[0] == 0
    (repo_path / "sub" / "u.txt").write_text("u\n", encoding="utf-8")
    assert (await run(git_rw, "status -s"))[1] == b" ? sub\n"
    assert (await run(git_rw, "status --porcelain"))[1] == b" M sub\n"
    assert (await run(git_rw, "status -s -uno"))[1] == b""
    (repo_path / "sub" / "in.txt").write_text("more\n", encoding="utf-8")
    assert (await run(git_rw, "status -s"))[1] == b" m sub\n"
    assert (await git_rw.shell("rm -rf /repo/sub")).exit_code == 0
    code, _out, err = await run(git_rw, "add -A")
    assert (code, err) == (0, b"")
    assert b"sub" not in staged(repo_path)
