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

import asyncio

import pytest

from mirage.commands.cli.builtin.git.objects import (LooseObjects,
                                                     VfsObjectStore,
                                                     load_object_store,
                                                     load_packs)

from .conftest import mounted, pack_everything

GITDIR = "/repo/.git"


async def loose_of(workspace) -> LooseObjects:
    """A loose-object reader bound to the running loop.

    Args:
        workspace (Workspace): the workspace under test.
    """
    return LooseObjects(workspace.dispatch, GITDIR, asyncio.get_running_loop())


@pytest.mark.asyncio
async def test_loose_ids_are_listed_without_reading_bodies(workspace):
    loose = await loose_of(workspace)
    ids = await asyncio.to_thread(lambda: list(loose.ids()))
    assert ids
    assert all(len(sha) == 40 for sha in ids)


@pytest.mark.asyncio
async def test_a_loose_object_is_fetched_by_id(workspace):
    loose = await loose_of(workspace)
    ids = await asyncio.to_thread(lambda: list(loose.ids()))
    obj = await asyncio.to_thread(loose.get, ids[0])
    assert obj is not None
    assert obj.id == ids[0]


@pytest.mark.asyncio
async def test_an_absent_id_reads_as_absent_rather_than_raising(workspace):
    loose = await loose_of(workspace)
    assert await asyncio.to_thread(loose.get, b"0" * 40) is None


@pytest.mark.asyncio
async def test_pack_directory_is_empty_before_packing(workspace):
    packs = await load_packs(workspace.dispatch, GITDIR,
                             asyncio.get_running_loop())
    assert packs == []


@pytest.mark.asyncio
async def test_packed_objects_are_served_from_the_pack(repo_path, workspace):
    pack_everything(repo_path)
    with mounted(repo_path) as packed_ws:
        packs = await load_packs(packed_ws.dispatch, GITDIR,
                                 asyncio.get_running_loop())
        assert len(packs) == 1
        assert await asyncio.to_thread(len, packs[0]) > 0


@pytest.mark.asyncio
async def test_the_store_serves_the_same_objects_either_way(
        repo_path, workspace):
    before = await load_object_store(workspace.dispatch, GITDIR)
    shas = await asyncio.to_thread(lambda: set(before))
    # Read them out before packing, not after: a lazy store reflects
    # what is on the backend now, and packing deletes the loose files.
    raws = {}
    for sha in shas:
        raws[sha] = await asyncio.to_thread(before.get_raw, sha)
    pack_everything(repo_path)
    with mounted(repo_path) as packed_ws:
        after = await load_object_store(packed_ws.dispatch, GITDIR)
        assert await asyncio.to_thread(lambda: set(after)) == shas
        for sha in shas:
            assert await asyncio.to_thread(after.get_raw, sha) == raws[sha]


@pytest.mark.asyncio
async def test_missing_object_raises_key_error(workspace):
    store = await load_object_store(workspace.dispatch, GITDIR)
    with pytest.raises(KeyError):
        await asyncio.to_thread(store.get_raw, b"0" * 40)


@pytest.mark.asyncio
async def test_contains_loose_distinguishes_the_two_forms(
        repo_path, workspace):
    store = await load_object_store(workspace.dispatch, GITDIR)
    sha = (await asyncio.to_thread(lambda: list(store)))[0]
    assert await asyncio.to_thread(store.contains_loose, sha)
    pack_everything(repo_path)
    with mounted(repo_path) as packed_ws:
        packed = await load_object_store(packed_ws.dispatch, GITDIR)
        assert not await asyncio.to_thread(packed.contains_loose, sha)
        assert await asyncio.to_thread(lambda: sha in packed)


@pytest.mark.asyncio
async def test_prefix_search_narrows_to_one_fanout_directory(workspace):
    # The inherited iter_prefix walks the whole store, which on a lazy
    # database means fetching every object to resolve an abbreviated id.
    store = await load_object_store(workspace.dispatch, GITDIR)
    sha = (await asyncio.to_thread(lambda: list(store)))[0]
    found = await asyncio.to_thread(lambda: list(store.iter_prefix(sha[:7])))
    assert sha in found


@pytest.mark.asyncio
async def test_prefix_search_finds_packed_ids_too(repo_path, workspace):
    store = await load_object_store(workspace.dispatch, GITDIR)
    sha = (await asyncio.to_thread(lambda: list(store)))[0]
    pack_everything(repo_path)
    with mounted(repo_path) as packed_ws:
        packed = await load_object_store(packed_ws.dispatch, GITDIR)
        found = await asyncio.to_thread(
            lambda: list(packed.iter_prefix(sha[:7])))
    assert sha in found


def test_store_refuses_to_write_a_pack():
    # Loose objects go back through the dispatcher one at a time, which
    # is what git writes as it works. A pack cannot be built that way,
    # and packing is a maintenance step mirage does not offer.
    store = VfsObjectStore(None, [])
    with pytest.raises(NotImplementedError):
        store.add_pack()
