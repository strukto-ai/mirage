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
    assert log == ["inv:/nc/data/x.txt", "inv:/nc/data", "deliver"]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_delete_routes_to_unlink():
    log: list[str] = []
    w = _watcher(log=log)
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.DELETE, "/nc/data/x.txt"))
    await asyncio.wait_for(task, timeout=2)
    assert log == ["inv-unlink:/nc/data/x.txt", "inv:/nc/data"]
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
    assert seen == ["data/x.txt", "data"]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_invalidates_ancestor_chain():
    # A nested external create implies intermediate dirs appeared, so
    # every cached listing up to the mount root must be evicted, not
    # just the file's immediate parent.
    seen: list[str] = []

    class RecordingManager:

        async def invalidate_after_write(self, path):
            seen.append(path.virtual)

        async def invalidate_after_unlink(self, path):
            seen.append(f"unlink:{path.virtual}")

    entry = FakeMountEntry(prefix="/nc/",
                           resource=PlainResource(),
                           cache_manager=RecordingManager())
    w = Watcher(FakeRegistry(entry))
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/sub/deep.txt"))
    await asyncio.wait_for(task, timeout=2)
    assert seen == ["/nc/data/sub/deep.txt", "/nc/data/sub", "/nc/data"]
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
    sub = Subscriber(queue=None, roots=("/nc", ), recursive=True)
    assert w._matches(sub, _change(ChangeKind.CREATE, "/nc/sub/deep.txt"))
    assert not w._matches(sub, _change(ChangeKind.CREATE, "/other/x.txt"))


def test_matches_nonrecursive_scope():
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc", ), recursive=False)
    assert w._matches(sub, _change(ChangeKind.CREATE, "/nc/top.txt"))
    assert not w._matches(sub, _change(ChangeKind.CREATE, "/nc/sub/deep.txt"))


def test_matches_glob_scope_one_level():
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc/data/*.txt", ), recursive=True)
    assert w._matches(sub, _change(ChangeKind.CREATE, "/nc/data/a.txt"))
    assert not w._matches(sub, _change(ChangeKind.CREATE, "/nc/data/a.md"))
    assert not w._matches(sub, _change(ChangeKind.CREATE,
                                       "/nc/data/sub/a.txt"))


def test_matches_glob_scope_covers_matched_dirs():
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc/data/sub*", ), recursive=True)
    assert w._matches(sub,
                      _change(ChangeKind.CREATE, "/nc/data/subdir/deep.txt"))
    assert not w._matches(sub, _change(ChangeKind.CREATE, "/nc/data/x.txt"))


def test_matches_any_of_multiple_roots():
    w = _watcher()
    sub = Subscriber(queue=None,
                     roots=("/nc/a", "/nc/b/keep.txt"),
                     recursive=True)
    assert w._matches(sub, _change(ChangeKind.UPDATE, "/nc/a/x.txt"))
    assert w._matches(sub, _change(ChangeKind.UPDATE, "/nc/b/keep.txt"))
    assert not w._matches(sub, _change(ChangeKind.UPDATE, "/nc/b/other.txt"))


@pytest.mark.asyncio
async def test_watch_accepts_path_list():
    w = _watcher()
    paths = [
        PathSpec.from_str_path("/nc/a"),
        PathSpec.from_str_path("/nc/b"),
    ]
    agen = w.watch(paths)
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await w.notify(_change(ChangeKind.CREATE, "/nc/b/y.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.path.virtual == "/nc/b/y.txt"
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_watch_glob_delivers_only_matches():
    w = _watcher()
    agen, task = await _start_blocked_watch(w, virtual="/nc/data/*.txt")
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/skip.md"))
    await w.notify(_change(ChangeKind.CREATE, "/nc/data/hit.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.path.virtual == "/nc/data/hit.txt"
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_watch_empty_path_list_raises():
    w = _watcher()
    agen = w.watch([])
    with pytest.raises(ValueError):
        await agen.__anext__()
    await w.close()
