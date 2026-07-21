import asyncio

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import ChangeKind, Delta, MountMode, PathSpec, ResourceChange
from mirage.watch import enable_watch
from mirage.workspace import Workspace


class OneShotHook:

    def __init__(self, change):
        self._change = change
        self._done = False

    async def pull(self, root, checkpoint):
        if self._done:
            return Delta(changes=(), checkpoint="1")
        self._done = True
        return Delta(changes=(self._change, ), checkpoint="1")


def _watchable_ram(change):
    resource = RAMResource()
    resource.delta_hook = lambda: OneShotHook(change)
    return resource


@pytest.mark.asyncio
async def test_watch_without_runtime_raises():
    ws = Workspace({"/data": RAMResource()})
    with pytest.raises(RuntimeError):
        ws.watch(PathSpec.from_str_path("/data"))
    await ws.close()


@pytest.mark.asyncio
async def test_enable_watch_delivers_through_workspace():
    change = ResourceChange(kind=ChangeKind.CREATE,
                            path=PathSpec.from_str_path("/data/new.txt"),
                            observed_at_ms=0)
    ws = Workspace({"/data": (_watchable_ram(change), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    enable_watch(ws, poll_interval=0.01)
    agen = ws.watch(PathSpec.from_str_path("/data"))
    got = await asyncio.wait_for(agen.__anext__(), timeout=2)
    assert got.kind is ChangeKind.CREATE
    assert got.path.virtual == "/data/new.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_close_workspace_stops_watcher():
    change = ResourceChange(kind=ChangeKind.CREATE,
                            path=PathSpec.from_str_path("/data/new.txt"),
                            observed_at_ms=0)
    ws = Workspace({"/data": (_watchable_ram(change), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = enable_watch(ws, poll_interval=0.01)
    agen = ws.watch(PathSpec.from_str_path("/data"))
    await asyncio.wait_for(agen.__anext__(), timeout=2)
    await ws.close()
    assert watcher._closed
