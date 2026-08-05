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

from mirage.commands.cli.builtin.git.refs import load_refs, read_head
from mirage.io import IOResult

from .conftest import make_branch, mounted, pack_refs

DETACHED_SHA = "cdd6234342b147880f5d86c55dad6c1fbe222bfe"


def _dispatch_returning(data: bytes):
    """A dispatch that answers every read with the given bytes.

    Args:
        data (bytes): the content HEAD holds.
    """

    async def dispatch(op: str, path, **kwargs):
        assert op == "read"
        assert path.virtual == "/repo/.git/HEAD"
        return data, IOResult()

    return dispatch


@pytest.mark.asyncio
async def test_symbolic_ref_reports_the_short_branch():
    head = await read_head(_dispatch_returning(b"ref: refs/heads/main\n"),
                           "/repo/.git")
    assert head.branch == "main"
    assert head.ref == "refs/heads/main"
    assert head.commit is None


@pytest.mark.asyncio
async def test_branch_name_keeps_its_slashes():
    head = await read_head(
        _dispatch_returning(b"ref: refs/heads/feat/git-cli\n"), "/repo/.git")
    assert head.branch == "feat/git-cli"


@pytest.mark.asyncio
async def test_detached_head_reports_the_commit():
    head = await read_head(_dispatch_returning(DETACHED_SHA.encode()),
                           "/repo/.git")
    assert head.branch is None
    assert head.ref is None
    assert head.commit == DETACHED_SHA


@pytest.mark.asyncio
async def test_ref_outside_refs_heads_keeps_its_full_name():
    head = await read_head(
        _dispatch_returning(b"ref: refs/remotes/origin/main\n"), "/repo/.git")
    assert head.branch == "refs/remotes/origin/main"
    assert head.ref == "refs/remotes/origin/main"


@pytest.mark.asyncio
async def test_load_refs_reads_loose_branches(workspace):
    refs = await load_refs(workspace.dispatch, "/repo/.git")
    keys = refs.allkeys()
    assert b"refs/heads/main" in keys
    assert b"HEAD" in keys


@pytest.mark.asyncio
async def test_load_refs_reads_packed_refs(repo_path, workspace):
    # A freshly cloned repository keeps its remote-tracking refs only in
    # packed-refs, so a loose-only reader would miss them entirely.
    pack_refs(repo_path)
    with mounted(repo_path) as ws:
        refs = await load_refs(ws.dispatch, "/repo/.git")
    assert b"refs/heads/main" in refs.allkeys()


@pytest.mark.asyncio
async def test_load_refs_walks_nested_ref_names(repo_path, workspace):
    make_branch(repo_path, "feat/git-cli")
    with mounted(repo_path) as ws:
        refs = await load_refs(ws.dispatch, "/repo/.git")
    assert b"refs/heads/feat/git-cli" in refs.allkeys()


@pytest.mark.asyncio
async def test_head_symref_resolves_through_the_container(workspace):
    refs = await load_refs(workspace.dispatch, "/repo/.git")
    assert refs[b"HEAD"] == refs[b"refs/heads/main"]
