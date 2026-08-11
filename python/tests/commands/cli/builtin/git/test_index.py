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

from mirage.commands.cli.builtin.git.index import read_index

GITDIR = "/repo/.git"


@pytest.mark.asyncio
async def test_the_index_lists_what_was_committed(workspace):
    state = await read_index(workspace.dispatch, GITDIR)
    assert sorted(state.entries) == [b"a.txt", b"b.txt"]


@pytest.mark.asyncio
async def test_each_entry_carries_the_blob_it_staged(workspace):
    state = await read_index(workspace.dispatch, GITDIR)
    entry = state.entries[b"a.txt"]
    assert len(entry.sha) == 40
    assert entry.size == len("one changed\n")


@pytest.mark.asyncio
async def test_a_repository_with_no_index_yet_is_empty_not_broken(
        workspace, repo_path: Path):
    # `git init` writes no index until the first `git add`, and every
    # path is then untracked, which an empty table already says.
    (repo_path / ".git" / "index").unlink()
    state = await read_index(workspace.dispatch, GITDIR)
    assert state.entries == {}
    assert state.conflicts == {}


@pytest.mark.asyncio
async def test_a_merge_head_is_what_marks_a_merge_in_progress(
        workspace, repo_path: Path):
    assert not (await read_index(workspace.dispatch, GITDIR)).merging
    (repo_path / ".git" / "MERGE_HEAD").write_bytes(b"0" * 40 + b"\n")
    assert (await read_index(workspace.dispatch, GITDIR)).merging


@pytest.mark.asyncio
async def test_conflicted_paths_are_carried_apart(workspace, repo_path: Path):
    # A conflicted path holds no ordinary entry, so folding it in with
    # the rest would make it compare equal to nothing and vanish from
    # the report while git is refusing to commit because of it.
    index = Index(str(repo_path / ".git" / "index"))
    staged = index[b"a.txt"]
    assert isinstance(staged, IndexEntry)
    index[b"a.txt"] = ConflictedIndexEntry(ancestor=staged,
                                           this=staged,
                                           other=staged)
    index.write()
    state = await read_index(workspace.dispatch, GITDIR)
    assert b"a.txt" not in state.entries
    assert b"a.txt" in state.conflicts
