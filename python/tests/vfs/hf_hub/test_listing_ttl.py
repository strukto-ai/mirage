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

import mirage.core.hf_hub.readdir as readdir_module
from mirage.types import MountMode, ReadSpec
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.fixtures.github_api import expired_on_arrival
from tests.fixtures.hf_hub_api import FakeHub, serve

REPO = ("models", "acme/widget")


def _hub() -> FakeHub:
    return FakeHub(repos={REPO: {"a.txt": b"alpha\n", "d/b.txt": b"bravo\n"}})


def _vfs(hub: FakeHub):
    return build_vfs(
        "hf_models", {"repo_id": "acme/widget", "endpoint": hub.url}
    )


def _ws(vfs, ttl: int = 600) -> Workspace:
    return Workspace(
        {"/m": Mount(vfs=vfs, mode=MountMode.READ, read=ReadSpec(ttl=ttl))}
    )


async def _out(ws: Workspace, line: str, session_id: str | None = None):
    kwargs = {} if session_id is None else {"session_id": session_id}
    result = await asyncio.wait_for(ws.shell(line, **kwargs), 10)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


@pytest.mark.asyncio
async def test_a_reader_arriving_mid_listing_waits_for_it(monkeypatch):
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub))
        first = second = None
        release = asyncio.Event()
        try:
            for session_id in ("s0", "s1"):
                ws.create_session(session_id)
            assert await _out(ws, "ls /m/d") == b"b.txt\n"
            await ws._registry.mount_for("/m/d").index.invalidate()
            walks = hub.count("tree")
            walking = asyncio.Event()
            original = readdir_module.fetch_tree

            async def gated(*args, **kwargs):
                if not walking.is_set():
                    walking.set()
                    await release.wait()
                return await original(*args, **kwargs)

            monkeypatch.setattr(readdir_module, "fetch_tree", gated)
            first = asyncio.ensure_future(_out(ws, "ls /m/d", "s0"))
            await asyncio.wait_for(walking.wait(), 5)
            second = asyncio.ensure_future(_out(ws, "ls /m/d", "s1"))
            await asyncio.sleep(0.02)
            waited = not second.done()
            release.set()
            outs = await asyncio.wait_for(asyncio.gather(first, second), 5)
            assert hub.count("tree") - walks == 1
            assert outs == [b"b.txt\n", b"b.txt\n"]
            assert waited
        finally:
            release.set()
            await asyncio.gather(
                *(task for task in (first, second) if task),
                return_exceptions=True,
            )
            await ws.close()


@pytest.mark.asyncio
async def test_ls_answers_from_the_refill_it_just_made():
    with serve(_hub()) as hub:
        vfs = _vfs(hub)
        store = expired_on_arrival()
        ws = _ws(vfs)
        ws.mount("/m").index_store = store
        ws._registry._attach_manager(ws.mount("/m"))
        try:
            assert ws._registry.mount_for("/m/d").index_store is store
            assert await _out(ws, "ls /m/d") == b"b.txt\n"
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_listing_is_served_until_the_mount_ttl_then_refetched():
    with serve(_hub()) as hub:
        ws = _ws(_vfs(hub), ttl=1)
        try:
            assert await _out(ws, "ls /m/d") == b"b.txt\n"
            hub.repos[REPO]["d/c.txt"] = b"charlie\n"
            assert await _out(ws, "ls /m/d") == b"b.txt\n"
            await asyncio.sleep(1.1)
            assert await _out(ws, "ls /m/d") == b"b.txt\nc.txt\n"
        finally:
            await ws.close()
