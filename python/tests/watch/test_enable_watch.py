import asyncio
from datetime import datetime, timezone

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import Delta, FileChangeKind, FileEvent, MountMode, PathSpec
from mirage.watch import enable_watch
from mirage.workspace import Workspace

_TS = datetime.fromtimestamp(0, tz=timezone.utc)


def _change(kind, virtual):
    return FileEvent(kind=kind,
                     path=PathSpec.from_str_path(virtual),
                     timestamp=_TS)


class OneShotHook:

    def __init__(self):
        self.calls = 0

    async def pull(self, root, checkpoint):
        self.calls += 1
        if checkpoint is None:
            return Delta(changes=(), checkpoint="base")
        return Delta(changes=(_change(FileChangeKind.UPDATE,
                                      "/data/doc.txt"), ),
                     checkpoint="next")


@pytest.mark.asyncio
async def test_watch_lazily_attaches_default_runtime():
    # No enable_watch call anywhere: the runtime attaches on first
    # use, and ws.notify is the consumer's injection point.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    assert ws._watch_runtime is None
    agen = ws.watch("/data")
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    assert ws._watch_runtime is not None
    await ws.notify(_change(FileChangeKind.CREATE, "/data/new.txt"))
    got = await asyncio.wait_for(task, timeout=2)
    assert got.path.virtual == "/data/new.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_idle_workspace_has_no_watch_state():
    ws = Workspace({"/data": RAMResource()})
    assert ws._watch_runtime is None
    await ws.close()
    assert ws._watch_runtime is None


@pytest.mark.asyncio
async def test_enable_watch_after_first_use_raises():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.notify(_change(FileChangeKind.UPDATE, "/data/a.txt"))
    with pytest.raises(RuntimeError):
        enable_watch(ws)
    await ws.close()


@pytest.mark.asyncio
async def test_notify_delivers_through_workspace_watch():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = enable_watch(ws)
    agen = ws.watch(PathSpec.from_str_path("/data"))
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await watcher.notify(_change(FileChangeKind.CREATE, "/data/new.txt"))
    got = await asyncio.wait_for(task, timeout=2)
    assert got.kind is FileChangeKind.CREATE
    assert got.path.virtual == "/data/new.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_watch_accepts_plain_string_path():
    # The issue-450 snippet shape: workspace.watch("/dir").
    # Coercion happens at the workspace boundary; the runtime below
    # only ever sees PathSpec.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = enable_watch(ws)
    agen = ws.watch("/data")
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await watcher.notify(_change(FileChangeKind.CREATE, "/data/new.txt"))
    got = await asyncio.wait_for(task, timeout=2)
    assert got.path.virtual == "/data/new.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_watch_accepts_string_list_and_glob():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = enable_watch(ws)
    agen = ws.watch(["/data/a", "/data/*.txt"])
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await watcher.notify(_change(FileChangeKind.CREATE, "/data/hit.txt"))
    got = await asyncio.wait_for(task, timeout=2)
    assert got.path.virtual == "/data/hit.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_pull_loop_over_delta_hook_feeds_notify():
    # The consumer-owned poller pattern: pull a delta from the
    # resource hook, feed each change to notify.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = enable_watch(ws)
    agen = ws.watch(PathSpec.from_str_path("/data"))
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)

    hook = OneShotHook()
    root = PathSpec.from_str_path("/data")
    checkpoint = None
    for _ in range(2):
        delta = await hook.pull(root, checkpoint)
        checkpoint = delta.checkpoint
        for change in delta.changes:
            await watcher.notify(change)

    got = await asyncio.wait_for(task, timeout=2)
    assert got.kind is FileChangeKind.UPDATE
    assert got.path.virtual == "/data/doc.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_close_workspace_stops_watcher():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = enable_watch(ws)
    agen = ws.watch(PathSpec.from_str_path("/data"))
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.close()
    assert watcher._closed
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(task, timeout=2)
    await agen.aclose()
