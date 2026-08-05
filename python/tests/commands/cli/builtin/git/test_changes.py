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
from dulwich.index import ConflictedIndexEntry, IndexEntry
from dulwich.object_store import MemoryObjectStore
from dulwich.objects import Blob

from mirage.commands.cli.builtin.git.changes import (conflict_codes,
                                                     head_entries, merge,
                                                     stage_changes,
                                                     work_changes)
from mirage.commands.cli.builtin.git.index import read_index
from mirage.commands.cli.builtin.git.repo import open_repo
from mirage.commands.cli.builtin.git.types import RepoLocation, WorkTree
from mirage.types import FileStat, FileType

REGULAR = 0o100644
EXECUTABLE = 0o100755
SYMLINK = 0o120000
LOCATION = RepoLocation(gitdir="/repo/.git",
                        commondir="/repo/.git",
                        worktree="/repo",
                        mount_root="/repo/")


def entry(sha: bytes, size: int = 4, mode: int = REGULAR) -> IndexEntry:
    """One index entry with only the fields the comparison reads.

    Args:
        sha (bytes): the staged blob id.
        size (int): the size the file had when staged.
        mode (int): the mode it was staged with.
    """
    return IndexEntry(ctime=0,
                      mtime=0,
                      dev=0,
                      ino=0,
                      mode=mode,
                      uid=0,
                      gid=0,
                      size=size,
                      sha=sha)


def stat(size: int | None = 4, mode: int | None = 0o644) -> FileStat:
    """What a mount reports about one file.

    Args:
        size (int | None): byte length, None when the mount cannot say.
        mode (int | None): permission bits, None when it has none.
    """
    return FileStat(name="x",
                    path="x",
                    type=FileType.TEXT,
                    size=size,
                    mode=mode)


def blobs(*contents: bytes) -> tuple[MemoryObjectStore, list[bytes]]:
    """A store holding each blob, and their ids in the same order.

    Args:
        contents (bytes): blob contents to store.
    """
    store = MemoryObjectStore()
    ids = []
    for content in contents:
        blob = Blob.from_string(content)
        store.add_object(blob)
        ids.append(blob.id)
    return store, ids


EMPTY_STORE = MemoryObjectStore()


def test_an_index_path_absent_from_head_is_added():
    staged = stage_changes(EMPTY_STORE, {}, {b"new.txt": entry(b"a" * 40)},
                           set())
    assert staged == {"new.txt": ("A", None)}


def test_a_head_path_absent_from_the_index_is_deleted():
    staged = stage_changes(EMPTY_STORE, {b"gone.txt": (REGULAR, b"a" * 40)},
                           {}, set())
    assert staged == {"gone.txt": ("D", None)}


def test_a_different_blob_is_a_modification():
    staged = stage_changes(EMPTY_STORE, {b"a.txt": (REGULAR, b"a" * 40)},
                           {b"a.txt": entry(b"b" * 40)}, set())
    assert staged == {"a.txt": ("M", None)}


def test_the_same_blob_is_no_change_at_all():
    staged = stage_changes(EMPTY_STORE, {b"a.txt": (REGULAR, b"a" * 40)},
                           {b"a.txt": entry(b"a" * 40)}, set())
    assert staged == {}


def test_a_mode_change_alone_is_a_modification():
    staged = stage_changes(EMPTY_STORE, {b"a.txt": (REGULAR, b"a" * 40)},
                           {b"a.txt": entry(b"a" * 40, mode=EXECUTABLE)},
                           set())
    assert staged == {"a.txt": ("M", None)}


def test_before_the_first_commit_everything_staged_is_new():
    staged = stage_changes(EMPTY_STORE, None, {b"a.txt": entry(b"a" * 40)},
                           set())
    assert staged == {"a.txt": ("A", None)}


def test_a_conflicted_path_is_not_compared_as_a_deletion():
    # It holds no ordinary index entry, so comparing it against HEAD
    # would find it on one side only and call it deleted, which is the
    # opposite of what is happening to it.
    staged = stage_changes(EMPTY_STORE, {b"f.txt": (REGULAR, b"a" * 40)}, {},
                           {b"f.txt"})
    assert staged == {}


def test_identical_content_moved_is_one_rename():
    store, (sha, ) = blobs(b"same content\n")
    staged = stage_changes(store, {b"old.txt": (REGULAR, sha)},
                           {b"new.txt": entry(sha)}, set())
    assert staged == {"new.txt": ("R", "old.txt")}


def test_a_move_that_also_edited_is_still_a_rename():
    store, (old, new) = blobs(b"alpha\nbeta\ngamma\ndelta\n",
                              b"alpha\nbeta\ngamma\ndelta\nepsilon\n")
    staged = stage_changes(store, {b"old.txt": (REGULAR, old)},
                           {b"new.txt": entry(new)}, set())
    assert staged == {"new.txt": ("R", "old.txt")}


def test_a_rewrite_is_not_a_rename():
    store, (old, new) = blobs(b"alpha\nbeta\ngamma\ndelta\n",
                              b"nothing\nlike\nthe\nother\nfile\nat\nall\n")
    staged = stage_changes(store, {b"old.txt": (REGULAR, old)},
                           {b"new.txt": entry(new)}, set())
    assert staged == {"old.txt": ("D", None), "new.txt": ("A", None)}


def test_a_symlink_is_never_paired_with_a_file():
    store, (sha, ) = blobs(b"target.txt")
    staged = stage_changes(store, {b"link": (SYMLINK, sha)},
                           {b"copy.txt": entry(sha)}, set())
    assert staged == {"link": ("D", None), "copy.txt": ("A", None)}


CONFLICTS = [
    ((True, True, True), "UU"),
    ((True, True, False), "UD"),
    ((True, False, True), "DU"),
    ((True, False, False), "DD"),
    ((False, True, True), "AA"),
    ((False, True, False), "AU"),
    ((False, False, True), "UA"),
]


@pytest.mark.parametrize("stages,code", CONFLICTS)
def test_each_surviving_stage_combination_has_its_code(stages, code):
    ancestor, this, other = stages
    staged = entry(b"a" * 40)
    conflict = ConflictedIndexEntry(ancestor=staged if ancestor else None,
                                    this=staged if this else None,
                                    other=staged if other else None)
    assert conflict_codes({b"f.txt": conflict}) == {"f.txt": code}


@pytest.mark.asyncio
async def test_a_missing_file_is_an_unstaged_deletion(workspace):
    entries = {b"gone.txt": entry(b"a" * 40)}
    changes = await work_changes(workspace.dispatch, "/repo", entries,
                                 WorkTree())
    assert changes == {"gone.txt": "D"}


@pytest.mark.asyncio
async def test_a_size_that_moved_needs_no_read(workspace):
    entries = {b"a.txt": entry(b"a" * 40, size=99)}
    found = WorkTree(files={"a.txt": stat(size=4)})
    changes = await work_changes(workspace.dispatch, "/repo", entries, found)
    assert changes == {"a.txt": "M"}


@pytest.mark.asyncio
async def test_matching_content_is_no_change(workspace, repo_path: Path):
    content = (repo_path / "a.txt").read_bytes()
    entries = {
        b"a.txt": entry(Blob.from_string(content).id, size=len(content))
    }
    found = WorkTree(files={"a.txt": stat(size=len(content))})
    changes = await work_changes(workspace.dispatch, "/repo", entries, found)
    assert changes == {}


@pytest.mark.asyncio
async def test_the_executable_bit_moving_is_a_modification(
        workspace, repo_path: Path):
    content = (repo_path / "a.txt").read_bytes()
    entries = {
        b"a.txt": entry(Blob.from_string(content).id, size=len(content))
    }
    found = WorkTree(files={"a.txt": stat(size=len(content), mode=0o755)})
    changes = await work_changes(workspace.dispatch, "/repo", entries, found)
    assert changes == {"a.txt": "M"}


@pytest.mark.asyncio
async def test_a_mount_with_no_modes_claims_nothing_about_them(
        workspace, repo_path: Path):
    # Most backends report no mode at all. Reading that as 0 would make
    # every executable file look changed on every one of them.
    content = (repo_path / "a.txt").read_bytes()
    entries = {
        b"a.txt":
        entry(Blob.from_string(content).id, size=len(content), mode=EXECUTABLE)
    }
    found = WorkTree(files={"a.txt": stat(size=len(content), mode=None)})
    changes = await work_changes(workspace.dispatch, "/repo", entries, found)
    assert changes == {}


def test_a_path_can_hold_a_letter_in_both_columns():
    rows = merge({"a.txt": ("M", None)}, {"a.txt": "M"}, {}, [])
    assert len(rows) == 1
    assert (rows[0].index_status, rows[0].tree_status) == ("M", "M")


def test_untracked_paths_follow_the_tracked_ones():
    rows = merge({"z.txt": ("M", None)}, {}, {}, ["a.txt"])
    assert [row.path for row in rows] == ["z.txt", "a.txt"]


def test_an_unmerged_path_sorts_among_the_tracked_ones():
    rows = merge({"a.txt": ("M", None)}, {}, {"m.txt": "UU"}, [])
    assert [row.path for row in rows] == ["a.txt", "m.txt"]


@pytest.mark.asyncio
async def test_head_entries_reads_the_committed_tree(workspace):
    repo = await open_repo(workspace.dispatch, LOCATION)
    tree = head_entries(repo)
    assert tree is not None
    assert sorted(tree) == [b"a.txt", b"b.txt"]


@pytest.mark.asyncio
async def test_head_entries_is_none_before_the_first_commit(
        workspace, repo_path: Path):
    (repo_path / ".git" / "refs" / "heads" / "main").unlink()
    repo = await open_repo(workspace.dispatch, LOCATION)
    assert head_entries(repo) is None


@pytest.mark.asyncio
async def test_the_index_and_the_tree_agree_on_a_clean_repository(workspace):
    repo = await open_repo(workspace.dispatch, LOCATION)
    state = await read_index(workspace.dispatch, "/repo/.git")
    assert stage_changes(repo.object_store, head_entries(repo), state.entries,
                         set()) == {}
