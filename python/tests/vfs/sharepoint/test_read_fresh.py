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

from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.fixtures.msgraph_api import (DRIVE_ID, DRIVE_NAME, SITE_NAME,
                                        FakeGraph, serve)

OLD = b"version one\n"
NEW = b"version two, longer\n"
SCOPED = "/m/a.txt"
UNSCOPED = f"/m/{SITE_NAME}/{DRIVE_NAME}/a.txt"


def _vfs(graph: FakeGraph, scoped: bool = True):
    config = {"access_token": "t", "graph_base_url": graph.url}
    if scoped:
        config.update(site=SITE_NAME, drive=DRIVE_NAME)
    return build_vfs("sharepoint", config)


def _ws(vfs) -> Workspace:
    return Workspace({
        "/m":
        Mount(vfs=vfs,
              mode=MountMode.WRITE,
              read=ReadSpec(policy=ReadPolicy.FRESH)),
        "/r": (RAMVFS(), MountMode.WRITE),
    })


async def _out(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


# The unscoped mount resolves the site and drive out of the path on every
# operation, a different road to the same item than the scoped one.
ROWS = [
    pytest.param(True, "cat {v}", id="scoped-stream"),
    pytest.param(True, "cp {v} /r/x && cat /r/x", id="scoped-bytes"),
    pytest.param(False, "cat {v}", id="unscoped-stream"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("scoped,line", ROWS)
async def test_a_write_between_the_token_and_the_bytes_is_refetched(
        scoped, line):
    with serve(FakeGraph(drives={DRIVE_ID: {"a.txt": OLD}})) as graph:
        ws = _ws(_vfs(graph, scoped))
        line = line.format(v=SCOPED if scoped else UNSCOPED)
        try:
            # The file changes after the bytes are taken and before they are
            # sent, so the read holds OLD while Graph already holds NEW. A
            # token read after the bytes would label OLD with NEW's cTag.
            graph.on_bytes(lambda: graph.write(DRIVE_ID, "a.txt", NEW))
            assert await _out(ws, line) == OLD
            assert graph.hook_fired == 1
            before = graph.fetches()
            assert await _out(ws, line) == NEW
            assert graph.fetches() - before == 1
            assert graph.reach == []
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_listed_ctag_never_answers_for_a_changed_file():
    with serve(FakeGraph(drives={DRIVE_ID: {"a.txt": OLD}},
                         children_allowed=1)) as graph:
        ws = _ws(_vfs(graph))
        try:
            # The listing leaves c1 in the mount index. A probe that trusted
            # it would match the c1 the cache holds and serve OLD.
            await _out(ws, "ls /m")
            assert await _out(ws, f"cat {SCOPED}") == OLD
            graph.write(DRIVE_ID, "a.txt", NEW)
            assert await _out(ws, f"cat {SCOPED}") == NEW
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_metadata_edit_does_not_refetch():
    with serve(FakeGraph(drives={DRIVE_ID: {"a.txt": OLD}})) as graph:
        ws = _ws(_vfs(graph))
        try:
            await _out(ws, f"cat {SCOPED}")
            # A rename or a property edit moves the eTag and the stamp, never
            # the cTag, so the cached bytes are still current.
            graph.touch(DRIVE_ID, "a.txt")
            before = graph.fetches()
            assert await _out(ws, f"cat {SCOPED}") == OLD
            assert graph.fetches() - before == 0
        finally:
            await ws.close()
