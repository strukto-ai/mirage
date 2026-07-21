import asyncio
from dataclasses import dataclass

import pytest

from mirage.types import ChangeKind, PathSpec, ResourceChange
from mirage.watch.source import Subscriber
from mirage.watch.watcher import Watcher


class FakeCacheManager:

    def __init__(self, log):
        self._log = log

    async def invalidate_after_write(self, path):
        self._log.append(f"inv:{path.virtual}")

    async def invalidate_after_unlink(self, path):
        self._log.append(f"inv-unlink:{path.virtual}")


class PlainResource:
    name = "ram"


@dataclass
class FakeMountEntry:
    prefix: str
    resource: object
    cache_manager: object = None


@dataclass
class FakeRegistry:
    entry: FakeMountEntry

    def mount_for(self, path: str) -> FakeMountEntry:
        return self.entry


def _change(kind, virtual):
    return ResourceChange(kind=kind,
                          path=PathSpec.from_str_path(virtual),
                          observed_at_ms=0)


def _watcher(log=None):
    manager = FakeCacheManager(log) if log is not None else None
    entry = FakeMountEntry(prefix="/nc/",
                           resource=PlainResource(),
                           cache_manager=manager)
    return Watcher(FakeRegistry(entry))


async def _start_blocked_watch(w, virtual="/nc"):
    """Start a watch iterator and let it register + block on pop.

    Returns the generator and the pending __anext__ task, so a test can
    inject via notify() and then await the delivery.
    """
    agen = w.watch(PathSpec.from_str_path(virtual))
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    return agen, task


@pytest.mark.asyncio
async def test_notify_delivers_change():
    w = _watcher()
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/x.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.kind is ChangeKind.CREATE
    assert change.path.virtual == "/nc/data/x.txt"
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_invalidate_before_deliver():
    log: list[str] = []
    w = _watcher(log=log)
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/x.txt"))
    await asyncio.wait_for(task, timeout=2)
    log.append("deliver")
    assert log == ["inv:/nc/data/x.txt", "deliver"]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_delete_routes_to_unlink():
    log: list[str] = []
    w = _watcher(log=log)
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.DELETE, "/nc/data/x.txt"))
    await asyncio.wait_for(task, timeout=2)
    assert log == ["inv-unlink:/nc/data/x.txt"]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_reframes_resource_path():
    seen: list[str] = []

    class RecordingManager:

        async def invalidate_after_write(self, path):
            seen.append(path.resource_path)

        async def invalidate_after_unlink(self, path):
            seen.append(path.resource_path)

    entry = FakeMountEntry(prefix="/nc/",
                           resource=PlainResource(),
                           cache_manager=RecordingManager())
    w = Watcher(FakeRegistry(entry))
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/x.txt"))
    await asyncio.wait_for(task, timeout=2)
    assert seen == ["data/x.txt"]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_fans_out_to_all_matching_watches():
    w = _watcher()
    a_gen, a_task = await _start_blocked_watch(w)
    b_gen, b_task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/x.txt"))
    a = await asyncio.wait_for(a_task, timeout=2)
    b = await asyncio.wait_for(b_task, timeout=2)
    assert a.path.virtual == b.path.virtual == "/nc/data/x.txt"
    await a_gen.aclose()
    await b_gen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_skips_out_of_scope_watch():
    w = _watcher()
    agen, task = await _start_blocked_watch(w, virtual="/nc/other")
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/x.txt"))
    await asyncio.sleep(0.05)
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_plain_resource_is_watchable():
    # No delta_hook capability required: delivery is notify-driven.
    w = _watcher()
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.UPDATE, "/nc/a.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.kind is ChangeKind.UPDATE
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_close_ends_blocked_iterator():
    w = _watcher()
    agen, task = await _start_blocked_watch(w)
    await w.close()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(task, timeout=2)
    await agen.aclose()


@pytest.mark.asyncio
async def test_notify_after_close_is_noop():
    w = _watcher()
    await w.close()
    await w.notify(_change(ChangeKind.CREATE, "/nc/a.txt"))
    assert w._subscribers == []


def test_matches_recursive_scope():
    w = _watcher()
    sub = Subscriber(queue=None, root_virtual="/nc", recursive=True)
    assert w._matches(sub, _change(ChangeKind.CREATE, "/nc/sub/deep.txt"))
    assert not w._matches(sub, _change(ChangeKind.CREATE, "/other/x.txt"))


def test_matches_nonrecursive_scope():
    w = _watcher()
    sub = Subscriber(queue=None, root_virtual="/nc", recursive=False)
    assert w._matches(sub, _change(ChangeKind.CREATE, "/nc/top.txt"))
    assert not w._matches(sub, _change(ChangeKind.CREATE, "/nc/sub/deep.txt"))
