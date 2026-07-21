import asyncio
from dataclasses import dataclass

import pytest

from mirage.types import ChangeKind, Delta, PathSpec, ResourceChange
from mirage.watch.source import Source, Subscriber
from mirage.watch.watcher import Watcher
from mirage.workspace.mount.registry import MountCommandUnsupported


class ScriptedHook:

    def __init__(self, batches):
        self._batches = list(batches)
        self.calls = 0

    async def pull(self, root, checkpoint):
        self.calls += 1
        changes = self._batches.pop(0) if self._batches else ()
        return Delta(changes=changes, checkpoint=str(self.calls))


class RepeatHook:

    def __init__(self, change):
        self._change = change
        self.calls = 0

    async def pull(self, root, checkpoint):
        self.calls += 1
        return Delta(changes=(self._change, ), checkpoint=str(self.calls))


class FakeCacheManager:

    def __init__(self, log):
        self._log = log

    async def invalidate_after_write(self, path):
        self._log.append(f"inv:{path.virtual}")

    async def invalidate_after_unlink(self, path):
        self._log.append(f"inv-unlink:{path.virtual}")


class FakeResource:

    def __init__(self, hook, name="nextcloud"):
        self._hook = hook
        self.name = name

    def delta_hook(self):
        return self._hook


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


def _watcher(hook, log=None):
    manager = FakeCacheManager(log) if log is not None else None
    entry = FakeMountEntry(prefix="/nc/",
                           resource=FakeResource(hook),
                           cache_manager=manager)
    return Watcher(FakeRegistry(entry), poll_interval=0.01)


@pytest.mark.asyncio
async def test_watch_delivers_change():
    hook = ScriptedHook([(_change(ChangeKind.CREATE, "/nc/a.txt"), )])
    w = _watcher(hook)
    agen = w.watch(PathSpec.from_str_path("/nc"))
    change = await asyncio.wait_for(agen.__anext__(), timeout=2)
    assert change.kind is ChangeKind.CREATE
    assert change.path.virtual == "/nc/a.txt"
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_invalidate_before_deliver():
    log: list[str] = []
    hook = ScriptedHook([(_change(ChangeKind.CREATE, "/nc/a.txt"), )])
    w = _watcher(hook, log=log)
    agen = w.watch(PathSpec.from_str_path("/nc"))
    await asyncio.wait_for(agen.__anext__(), timeout=2)
    log.append("deliver:/nc/a.txt")
    assert log == ["inv:/nc/a.txt", "deliver:/nc/a.txt"]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_delete_routes_to_unlink_invalidation():
    log: list[str] = []
    hook = ScriptedHook([(_change(ChangeKind.DELETE, "/nc/a.txt"), )])
    w = _watcher(hook, log=log)
    agen = w.watch(PathSpec.from_str_path("/nc"))
    await asyncio.wait_for(agen.__anext__(), timeout=2)
    assert log == ["inv-unlink:/nc/a.txt"]
    await agen.aclose()
    await w.close()


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
async def test_notify_delivers_precise_change():
    w = _watcher(ScriptedHook([]))
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
    w = _watcher(ScriptedHook([]), log=log)
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
    w = _watcher(ScriptedHook([]), log=log)
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
                           resource=FakeResource(ScriptedHook([])),
                           cache_manager=RecordingManager())
    w = Watcher(FakeRegistry(entry), poll_interval=0.01)
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/x.txt"))
    await asyncio.wait_for(task, timeout=2)
    assert seen == ["data/x.txt"]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_shared_source_refcounted():
    hook = RepeatHook(_change(ChangeKind.CREATE, "/nc/a.txt"))
    w = _watcher(hook)
    a = w.watch(PathSpec.from_str_path("/nc"))
    b = w.watch(PathSpec.from_str_path("/nc"))
    await asyncio.wait_for(a.__anext__(), timeout=2)
    await asyncio.wait_for(b.__anext__(), timeout=2)
    assert len(w._sources) == 1
    await a.aclose()
    assert len(w._sources) == 1
    await b.aclose()
    assert len(w._sources) == 0
    await w.close()


@pytest.mark.asyncio
async def test_unsupported_resource_raises():
    entry = FakeMountEntry(prefix="/ram/", resource=PlainResource())
    w = Watcher(FakeRegistry(entry), poll_interval=0.01)
    with pytest.raises(MountCommandUnsupported):
        agen = w.watch(PathSpec.from_str_path("/ram"))
        await agen.__anext__()
    await w.close()


def test_matches_recursive_scope():
    w = _watcher(ScriptedHook([]))
    sub = Subscriber(queue=None, root_virtual="/nc", recursive=True)
    assert w._matches(sub, _change(ChangeKind.CREATE, "/nc/sub/deep.txt"))
    assert not w._matches(sub, _change(ChangeKind.CREATE, "/other/x.txt"))


def test_matches_nonrecursive_scope():
    w = _watcher(ScriptedHook([]))
    sub = Subscriber(queue=None, root_virtual="/nc", recursive=False)
    assert w._matches(sub, _change(ChangeKind.CREATE, "/nc/top.txt"))
    assert not w._matches(sub, _change(ChangeKind.CREATE, "/nc/sub/deep.txt"))


def test_nudge_wakes_matching_source():
    w = _watcher(ScriptedHook([]))
    root = PathSpec.from_str_path("/nc")
    source = Source(entry=None, root=root, hook=ScriptedHook([]))
    w._sources[("/nc/", "/nc")] = source
    assert not source.wake.is_set()
    w.nudge(PathSpec.from_str_path("/nc/data/file.txt"))
    assert source.wake.is_set()


def test_nudge_ignores_unrelated_source():
    w = _watcher(ScriptedHook([]))
    root = PathSpec.from_str_path("/nc")
    source = Source(entry=None, root=root, hook=ScriptedHook([]))
    w._sources[("/nc/", "/nc")] = source
    w.nudge(PathSpec.from_str_path("/other/file.txt"))
    assert not source.wake.is_set()
