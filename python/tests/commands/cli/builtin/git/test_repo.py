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
from dulwich.objects import Commit
from dulwich.walk import Walker

from mirage.commands.cli.builtin.git.discover import discover
from mirage.commands.cli.builtin.git.repo import open_repo

from .conftest import commit_file, pack_everything, repo_facts

HEAD = b"HEAD"
MAIN = b"refs/heads/main"


async def _open(ws):
    """Discover and open the repository mounted at /repo.

    Args:
        ws (Workspace): the workspace under test.
    """
    location = await discover(*repo_facts(ws), "/repo")
    return await open_repo(ws.dispatch, location)


@pytest.mark.asyncio
async def test_opens_a_loose_object_repository(workspace):
    repo = await _open(workspace)
    assert MAIN in repo.refs.allkeys()
    head = repo[repo.refs[MAIN]]
    assert isinstance(head, Commit)
    assert head.message == b"third"


@pytest.mark.asyncio
async def test_opens_a_packed_repository(repo_path, workspace):
    # Toolathlon's repositories arrive packed, so serving one whose
    # objects are not loose at all is the real case, not an edge case.
    pack_everything(repo_path)
    repo = await _open(workspace)
    head = repo[repo.refs[MAIN]]
    assert head.message == b"third"
    assert len(list(Walker(repo.object_store, [head.id]))) == 3


@pytest.mark.asyncio
async def test_history_walks_across_both_storage_forms(repo_path, workspace):
    # A repository packed once and committed to since holds its history
    # in the pack and its tip loose; neither reader alone can walk it.
    pack_everything(repo_path)
    commit_file(repo_path, "c.txt", "three\n", "fourth")
    repo = await _open(workspace)
    head = repo[repo.refs[MAIN]]
    assert head.message == b"fourth"
    messages = [
        entry.commit.message for entry in Walker(repo.object_store, [head.id])
    ]
    assert messages == [b"fourth", b"third", b"second", b"first"]


@pytest.mark.asyncio
async def test_head_resolves_through_its_symbolic_ref(workspace):
    repo = await _open(workspace)
    assert repo.refs[HEAD] == repo.refs[MAIN]


@pytest.mark.asyncio
async def test_blob_content_survives_the_round_trip(workspace):
    repo = await _open(workspace)
    head = repo[repo.refs[MAIN]]
    tree = repo[head.tree]
    _mode, blob_id = tree[b"a.txt"]
    assert repo[blob_id].data == b"one changed\n"
