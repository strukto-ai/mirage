import asyncio
from datetime import datetime, timezone
from functools import partial

import pytest

from mirage.resource.ram import RAMResource
from mirage.types import Delta, FileChangeKind, FileEvent, MountMode, PathSpec
from mirage.watch import RAMWatchQueue, Watcher
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


def _attach_custom(ws, **queue_kwargs):
    watcher = Watcher(ws.registry,
                      queue_factory=partial(RAMWatchQueue, **queue_kwargs))
    ws.attach_watch_runtime(watcher)
    return watcher


@pytest.mark.asyncio
async def test_watch_lazily_attaches_default_runtime():
    # No attach call anywhere: the runtime attaches on first use, and
    # ws.notify is the consumer's injection point.
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
async def test_attach_after_first_use_raises():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    await ws.notify(_change(FileChangeKind.UPDATE, "/data/a.txt"))
    with pytest.raises(RuntimeError):
        ws.attach_watch_runtime(Watcher(ws.registry))
    await ws.close()


@pytest.mark.asyncio
async def test_attached_custom_runtime_serves_watch():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = _attach_custom(ws, max_pending=8)
    assert ws._watch_runtime is watcher
    agen = ws.watch(PathSpec.from_str_path("/data"))
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.notify(_change(FileChangeKind.CREATE, "/data/new.txt"))
    got = await asyncio.wait_for(task, timeout=2)
    assert got.kind is FileChangeKind.CREATE
    assert got.path.virtual == "/data/new.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_detach_closes_queues_and_resets_to_idle():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = _attach_custom(ws, max_pending=8)
    agen = ws.watch("/data")
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.detach_watch_runtime()
    assert watcher._closed
    assert ws._watch_runtime is None
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(task, timeout=2)
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_detach_then_lazy_reattach_delivers_again():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    old = _attach_custom(ws, max_pending=8)
    await ws.detach_watch_runtime()
    agen = ws.watch("/data")
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    assert ws._watch_runtime is not None
    assert ws._watch_runtime is not old
    await ws.notify(_change(FileChangeKind.CREATE, "/data/again.txt"))
    got = await asyncio.wait_for(task, timeout=2)
    assert got.path.virtual == "/data/again.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_detach_idle_workspace_is_noop():
    ws = Workspace({"/data": RAMResource()})
    await ws.detach_watch_runtime()
    assert ws._watch_runtime is None
    await ws.close()


@pytest.mark.asyncio
async def test_each_watch_owns_its_queue():
    # Two watches on overlapping scopes: one event fans out into both
    # queues independently.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    gen_a = ws.watch("/data")
    gen_b = ws.watch("/data/*.txt")
    task_a = asyncio.ensure_future(gen_a.__anext__())
    task_b = asyncio.ensure_future(gen_b.__anext__())
    await asyncio.sleep(0.03)
    runtime = ws._watch_runtime
    assert len(runtime._subscribers) == 2
    queues = {id(sub.queue) for sub in runtime._subscribers}
    assert len(queues) == 2
    await ws.notify(_change(FileChangeKind.CREATE, "/data/hit.txt"))
    got_a = await asyncio.wait_for(task_a, timeout=2)
    got_b = await asyncio.wait_for(task_b, timeout=2)
    assert got_a.path.virtual == "/data/hit.txt"
    assert got_b.path.virtual == "/data/hit.txt"
    await gen_a.aclose()
    await gen_b.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_multi_root_overflow_collapses_per_root():
    # A multi-root watch that overflows emits one UNKNOWN per root, so
    # the re-inventory signal covers every scope the watch spans.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    _attach_custom(ws, max_pending=2)
    agen = ws.watch(["/data/a", "/data/b"])
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.notify(_change(FileChangeKind.CREATE, "/data/a/first.txt"))
    await asyncio.wait_for(task, timeout=2)
    for i in range(3):
        await ws.notify(_change(FileChangeKind.CREATE, f"/data/a/f{i}.txt"))
    first = await asyncio.wait_for(agen.__anext__(), timeout=2)
    second = await asyncio.wait_for(agen.__anext__(), timeout=2)
    assert first.kind is FileChangeKind.UNKNOWN
    assert second.kind is FileChangeKind.UNKNOWN
    assert {first.path.virtual, second.path.virtual} == \
        {"/data/a", "/data/b"}
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_watch_spans_nested_mounts():
    # A mount nested inside another mount's subtree: one watch on the
    # shared ancestor receives events from both, and each event is
    # reframed to the mount that owns its path (longest prefix), so
    # invalidation hits the true owner.
    ws = Workspace(
        {
            "/nc1": (RAMResource(), MountMode.WRITE),
            "/nc1/abc/inner": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE)
    agen = ws.watch("/nc1/abc")
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.notify(_change(FileChangeKind.CREATE, "/nc1/abc/report.txt"))
    outer = await asyncio.wait_for(task, timeout=2)
    assert outer.path.virtual == "/nc1/abc/report.txt"
    assert outer.path.resource_path == "abc/report.txt"
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.notify(_change(FileChangeKind.CREATE, "/nc1/abc/inner/x.txt"))
    inner = await asyncio.wait_for(task, timeout=2)
    assert inner.path.virtual == "/nc1/abc/inner/x.txt"
    assert inner.path.resource_path == "x.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_watch_accepts_plain_string_path():
    # The issue-450 snippet shape: workspace.watch("/dir").
    # Coercion happens at the workspace boundary; the runtime below
    # only ever sees PathSpec.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    agen = ws.watch("/data")
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.notify(_change(FileChangeKind.CREATE, "/data/new.txt"))
    got = await asyncio.wait_for(task, timeout=2)
    assert got.path.virtual == "/data/new.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_watch_accepts_string_list_and_glob():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    agen = ws.watch(["/data/a", "/data/*.txt"])
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.notify(_change(FileChangeKind.CREATE, "/data/hit.txt"))
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
            await ws.notify(change)

    got = await asyncio.wait_for(task, timeout=2)
    assert got.kind is FileChangeKind.UPDATE
    assert got.path.virtual == "/data/doc.txt"
    await agen.aclose()
    await ws.close()


@pytest.mark.asyncio
async def test_close_workspace_stops_watcher():
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE)
    watcher = _attach_custom(ws, max_pending=8)
    agen = ws.watch(PathSpec.from_str_path("/data"))
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await ws.close()
    assert watcher._closed
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(task, timeout=2)
    await agen.aclose()
