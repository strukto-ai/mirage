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

from mirage.core.onedrive.read import read_bytes
from mirage.core.onedrive.stream import read_stream
from mirage.observe.context import RecordingScope
from mirage.types import MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.fixtures.msgraph_api import ME, FakeGraph, serve

OLD = b"version one\n"
NEW = b"version two, longer\n"
CAT = "cat /m/a.txt"
CP = "cp /m/a.txt /r/x && cat /r/x"


def _vfs(graph: FakeGraph):
    return build_vfs("onedrive", {
        "access_token": "t",
        "graph_base_url": graph.url
    })


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


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual="/" + path,
                    directory="/",
                    vfs_path=path,
                    raw_path="/" + path)


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [CAT, CP], ids=["stream", "bytes"])
async def test_a_write_between_the_token_and_the_bytes_is_refetched(line):
    with serve(FakeGraph(drives={ME: {"a.txt": OLD}})) as graph:
        ws = _ws(_vfs(graph))
        try:
            # The file changes after the bytes are taken and before they are
            # sent, so the read holds OLD while Graph already holds NEW. A
            # token read after the bytes would label OLD with NEW's cTag.
            graph.on_bytes(lambda: graph.write(ME, "a.txt", NEW))
            assert await _out(ws, line) == OLD
            assert graph.hook_fired == 1
            before = graph.fetches()
            assert await _out(ws, line) == NEW
            assert graph.fetches() - before == 1
            assert graph.reach == []
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_an_unrecorded_read_fetches_the_bare_item_then_its_bytes():
    with serve(FakeGraph(drives={ME: {"a.txt": OLD}})) as graph:
        vfs = _vfs(graph)
        try:
            data = await read_bytes(vfs.accessor, _spec("a.txt"))
        finally:
            await vfs.accessor.close()
    assert data == OLD
    # No version history: the revision only matters to a snapshot, and only
    # a recorded read can land in one.
    assert graph.log == [("item", "a.txt", ""), ("download", "a.txt", "")]


@pytest.mark.asyncio
@pytest.mark.parametrize("slot", ["bytes", "stream"])
async def test_a_recorded_read_keeps_the_revision_snapshots_pin(slot):
    with serve(FakeGraph(drives={ME: {"a.txt": OLD}})) as graph:
        graph.write(ME, "a.txt", NEW)
        vfs = _vfs(graph)
        scope = RecordingScope()
        try:
            if slot == "bytes":
                data = await read_bytes(vfs.accessor, _spec("a.txt"))
            else:
                data = b"".join([
                    c async for c in read_stream(vfs.accessor, _spec("a.txt"))
                ])
        finally:
            scope.close()
            await vfs.accessor.close()
    assert data == NEW
    assert graph.queries("item") == ["$expand=versions"]
    assert [(r.fingerprint, r.revision)
            for r in scope.records] == [("c2", "2.0")]


# Measured on the first green run, then pinned. The listing makes every
# ordinary stat an index hit, so what is left is the reconcile probes: cat
# pays routing's and the cache gate's, cp skips routing (write commands are
# not reconciled there) and keeps the gate. A warm read downloads nothing
# and lists nothing.
WARM = [
    (CAT, 2),
    ("cat /m/a.txt | head -c 1", 2),
    ("cp /m/a.txt /r/a.txt", 1),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line,items", WARM)
async def test_a_warm_fresh_read_costs_one_item_per_probe(line, items):
    with serve(FakeGraph(drives={ME: {
            "a.txt": OLD
    }}, children_allowed=1)) as graph:
        ws = _ws(_vfs(graph))
        try:
            await _out(ws, "ls /m")
            await _out(ws, CAT)
            graph.log.clear()
            await _out(ws, line)
            assert (graph.count("item"), graph.fetches(),
                    graph.count("children")) == (items, 0, 0)
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_ranged_read_stamps_the_whole_items_ctag():
    with serve(FakeGraph(drives={ME: {"a.txt": OLD}})) as graph:
        vfs = _vfs(graph)
        scope = RecordingScope()
        try:
            data = await read_bytes(vfs.accessor,
                                    _spec("a.txt"),
                                    offset=2,
                                    size=3)
        finally:
            scope.close()
            await vfs.accessor.close()
    assert data == OLD[2:5]
    assert [r.fingerprint for r in scope.records] == ["c1"]
    assert (graph.count("download"), graph.count("content")) == (1, 0)


@pytest.mark.asyncio
async def test_a_listed_ctag_never_answers_for_a_changed_file():
    with serve(FakeGraph(drives={ME: {
            "a.txt": OLD
    }}, children_allowed=1)) as graph:
        ws = _ws(_vfs(graph))
        try:
            # The listing leaves c1 in the mount index. A probe that trusted
            # it would match the c1 the cache holds and serve OLD.
            await _out(ws, "ls /m")
            # The fixture held: the mount index answers a stat with c1 and
            # no request of its own, so there is a stale row to trust.
            mount = ws.mount("/m")
            items = graph.count("item")
            listed = await mount.execute_op("stat",
                                            "/m/a.txt",
                                            index=mount.index)
            assert (listed.fingerprint, graph.count("item")) == ("c1", items)
            assert await _out(ws, CAT) == OLD
            graph.write(ME, "a.txt", NEW)
            assert await _out(ws, CAT) == NEW
            assert (graph.count("children"), graph.reach) == (1, [])
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_a_metadata_edit_does_not_refetch():
    with serve(FakeGraph(drives={ME: {"a.txt": OLD}})) as graph:
        ws = _ws(_vfs(graph))
        try:
            await _out(ws, CAT)
            # A rename or a property edit moves the eTag and the stamp, never
            # the cTag, so the cached bytes are still current.
            graph.touch(ME, "a.txt")
            before = graph.fetches()
            assert await _out(ws, CAT) == OLD
            assert graph.fetches() - before == 0
        finally:
            await ws.close()
