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
from dulwich.index import ConflictedIndexEntry, Index, IndexEntry

from mirage.commands.cli.builtin.git.index_file import (
    read_index,
    unchanged,
    with_fingerprint,
)
from mirage.types import FileStat, FileType

from .conftest import GITDIR


@pytest.mark.asyncio
async def test_the_index_lists_what_was_committed(workspace):
    state = await read_index(workspace.vfs, GITDIR)
    assert sorted(state.entries) == [b"a.txt", b"b.txt"]


@pytest.mark.asyncio
async def test_each_entry_carries_the_blob_it_staged(workspace):
    state = await read_index(workspace.vfs, GITDIR)
    entry = state.entries[b"a.txt"]
    assert len(entry.sha) == 40
    assert entry.size == len("one changed\n")


@pytest.mark.asyncio
async def test_a_repository_with_no_index_yet_is_empty_not_broken(
    workspace, repo_path: Path
):
    # `git init` writes no index until the first `git add`, and every
    # path is then untracked, which an empty table already says.
    (repo_path / ".git" / "index").unlink()
    state = await read_index(workspace.vfs, GITDIR)
    assert state.entries == {}
    assert state.conflicts == {}


@pytest.mark.asyncio
async def test_a_merge_head_is_what_marks_a_merge_in_progress(
    workspace, repo_path: Path
):
    assert not (await read_index(workspace.vfs, GITDIR)).merging
    (repo_path / ".git" / "MERGE_HEAD").write_bytes(b"0" * 40 + b"\n")
    assert (await read_index(workspace.vfs, GITDIR)).merging


@pytest.mark.asyncio
async def test_conflicted_paths_are_carried_apart(workspace, repo_path: Path):
    # A conflicted path holds no ordinary entry, so folding it in with
    # the rest would make it compare equal to nothing and vanish from
    # the report while git is refusing to commit because of it.
    index = Index(str(repo_path / ".git" / "index"))
    staged = index[b"a.txt"]
    assert isinstance(staged, IndexEntry)
    index[b"a.txt"] = ConflictedIndexEntry(
        ancestor=staged, this=staged, other=staged
    )
    index.write()
    state = await read_index(workspace.vfs, GITDIR)
    assert b"a.txt" not in state.entries
    assert b"a.txt" in state.conflicts


ENTRY = IndexEntry(
    ctime=0,
    mtime=0,
    dev=0,
    ino=0,
    mode=0o100644,
    uid=0,
    gid=0,
    size=3,
    sha=b"0" * 40,
)


def _stat(fingerprint: str | None) -> FileStat:
    return FileStat(
        name="a.txt", size=3, type=FileType.FILE, fingerprint=fingerprint
    )


def test_an_entry_keeping_a_fingerprint_finds_the_file_unchanged_by_it():
    kept = with_fingerprint(ENTRY, _stat("1:100.000000001"))
    assert (kept.dev, kept.ino) != (0, 0)
    assert unchanged(kept, _stat("1:100.000000001"))
    assert not unchanged(kept, _stat("1:100.000000002"))


def test_a_file_the_mount_fingerprints_not_is_never_unchanged_unread():
    assert with_fingerprint(ENTRY, _stat(None)) == ENTRY
    assert not unchanged(ENTRY, _stat("1:100.000000001"))
    assert not unchanged(with_fingerprint(ENTRY, _stat("x")), _stat(None))


def test_an_entry_keeps_the_same_two_numbers_typescript_keeps():
    # An index one host writes, the other reads: both take the first eight
    # bytes of the fingerprint's SHA-1 as dev and ino.
    kept = with_fingerprint(ENTRY, _stat("1:100.000000001"))
    assert (kept.dev, kept.ino) == (0x1C236B98, 0x703AC08A)
