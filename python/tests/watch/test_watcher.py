import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone

import pytest

from mirage.types import FileChangeKind, FileEvent, PathSpec
from mirage.watch.source import Subscriber
from mirage.watch.watcher import Watcher

_TS = datetime.fromtimestamp(0, tz=timezone.utc)


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
    return FileEvent(kind=kind,
                     path=PathSpec.from_str_path(virtual),
                     timestamp=_TS)


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
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.kind is FileChangeKind.CREATE
    assert change.path.virtual == "/nc/data/x.txt"
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_invalidate_before_deliver():
    log: list[str] = []
    w = _watcher(log=log)
    agen, task = await _start_blocked_watch(w)
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
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
    await w.notify(_change(FileChangeKind.DELETE, "/nc/data/x.txt"))
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
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
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
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/sub/deep.txt"))
    await asyncio.wait_for(task, timeout=2)
    assert seen == ["/nc/data/sub/deep.txt", "/nc/data/sub", "/nc/data"]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_move_evicts_both_sides():
    # The vacated old path must be evicted as an unlink (plus its
    # ancestors), or a consumer could cat the old path and get stale
    # cached bytes.
    log: list[str] = []
    w = _watcher(log=log)
    agen, task = await _start_blocked_watch(w)
    move = FileEvent(kind=FileChangeKind.MOVE,
                     path=PathSpec.from_str_path("/nc/data/new.txt"),
                     previous_path=PathSpec.from_str_path("/nc/old/orig.txt"),
                     timestamp=_TS)
    await w.notify(move)
    await asyncio.wait_for(task, timeout=2)
    assert log == [
        "inv:/nc/data/new.txt",
        "inv:/nc/data",
        "inv-unlink:/nc/old/orig.txt",
        "inv:/nc/old",
    ]
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_notify_fans_out_to_all_matching_watches():
    w = _watcher()
    a_gen, a_task = await _start_blocked_watch(w)
    b_gen, b_task = await _start_blocked_watch(w)
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
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
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
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
    await w.notify(_change(FileChangeKind.UPDATE, "/nc/a.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.kind is FileChangeKind.UPDATE
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
    await w.notify(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    assert w._subscribers == []


def test_matches_literal_root_is_whole_subtree():
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc", ))
    assert w._matches(sub, _change(FileChangeKind.CREATE, "/nc/top.txt"))
    assert w._matches(sub, _change(FileChangeKind.CREATE, "/nc/sub/deep.txt"))
    assert not w._matches(sub, _change(FileChangeKind.CREATE, "/other/x.txt"))


def test_matches_glob_scope_one_level():
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc/data/*.txt", ))
    assert w._matches(sub, _change(FileChangeKind.CREATE, "/nc/data/a.txt"))
    assert not w._matches(sub, _change(FileChangeKind.CREATE, "/nc/data/a.md"))
    assert not w._matches(sub,
                          _change(FileChangeKind.CREATE, "/nc/data/sub/a.txt"))


def test_matches_slashless_glob_is_shallow():
    # GNU depth semantics: /nc/data/* is the entries themselves —
    # the glob spelling of a shallow watch, no descent.
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc/data/*", ))
    assert w._matches(sub, _change(FileChangeKind.CREATE, "/nc/data/a.txt"))
    assert w._matches(sub, _change(FileChangeKind.CREATE, "/nc/data/sub"))
    assert not w._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/sub/deep.txt"))


def test_matches_trailing_slash_glob_scopes_dir_subtrees():
    # GNU */ matches directories only; the watch scope is everything
    # strictly inside them.
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc/data/*/", ))
    assert w._matches(sub,
                      _change(FileChangeKind.CREATE, "/nc/data/sub/deep.txt"))
    assert w._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/sub/nested/x.txt"))
    assert not w._matches(sub,
                          _change(FileChangeKind.CREATE, "/nc/data/top.txt"))


def test_matches_glob_scope_covers_matched_dirs():
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc/data/sub*/", ))
    assert w._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/subdir/deep.txt"))
    assert not w._matches(sub, _change(FileChangeKind.CREATE,
                                       "/nc/data/x.txt"))
    shallow = Subscriber(queue=None, roots=("/nc/data/sub*", ))
    assert w._matches(shallow, _change(FileChangeKind.CREATE,
                                       "/nc/data/subdir"))
    assert not w._matches(
        shallow, _change(FileChangeKind.CREATE, "/nc/data/subdir/deep.txt"))


def test_matches_glob_middle_wildcard_fine_grained():
    # /nc/data/*/abc/: everything inside any project dir's abc;
    # /nc/data/*/abc (no slash): the abc entries themselves.
    w = _watcher()
    inside = Subscriber(queue=None, roots=("/nc/data/*/abc/", ))
    assert w._matches(
        inside, _change(FileChangeKind.CREATE,
                        "/nc/data/proj1/abc/report.txt"))
    assert w._matches(
        inside, _change(FileChangeKind.CREATE,
                        "/nc/data/proj1/abc/deep/x.txt"))
    assert not w._matches(
        inside, _change(FileChangeKind.CREATE, "/nc/data/proj1/other.txt"))
    assert not w._matches(inside, _change(FileChangeKind.CREATE,
                                          "/nc/data/abc"))
    entry = Subscriber(queue=None, roots=("/nc/data/*/abc", ))
    assert w._matches(entry,
                      _change(FileChangeKind.CREATE, "/nc/data/proj1/abc"))
    assert not w._matches(
        entry, _change(FileChangeKind.CREATE, "/nc/data/proj1/abc/report.txt"))


def test_matches_any_of_multiple_roots():
    w = _watcher()
    sub = Subscriber(queue=None, roots=("/nc/a", "/nc/b/keep.txt"))
    assert w._matches(sub, _change(FileChangeKind.UPDATE, "/nc/a/x.txt"))
    assert w._matches(sub, _change(FileChangeKind.UPDATE, "/nc/b/keep.txt"))
    assert not w._matches(sub, _change(FileChangeKind.UPDATE,
                                       "/nc/b/other.txt"))


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
    await w.notify(_change(FileChangeKind.CREATE, "/nc/b/y.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.path.virtual == "/nc/b/y.txt"
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_watch_preserves_trailing_slash_scope():
    # The trailing slash must survive subscription framing: /nc/data/*/
    # scopes inside child dirs, and framing must not collapse it to
    # the shallow /nc/data/* form.
    w = _watcher()
    agen, task = await _start_blocked_watch(w, virtual="/nc/data/*/")
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/top.txt"))
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/sub/deep.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.path.virtual == "/nc/data/sub/deep.txt"
    await agen.aclose()
    await w.close()


@pytest.mark.asyncio
async def test_watch_glob_delivers_only_matches():
    w = _watcher()
    agen, task = await _start_blocked_watch(w, virtual="/nc/data/*.txt")
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/skip.md"))
    await w.notify(_change(FileChangeKind.CREATE, "/nc/data/hit.txt"))
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
