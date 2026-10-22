import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.base import Accessor
from mirage.accessor.responses import ResponseCache
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.config import LookupStatus
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.events.hub import EventHub
from mirage.events.queue.ram import RAMEventQueue
from mirage.events.source import Subscriber
from mirage.types import (
    FileChangeKind,
    FileEvent,
    FileStat,
    FileType,
    PathSpec,
)

_TS = datetime.fromtimestamp(0, tz=timezone.utc)


class FakeCacheManager:
    def __init__(self, log):
        self._log = log

    async def invalidate(self, path, kind):
        self._log.append(f"{kind}:{path.virtual}")


class PlainVFS:
    name = "ram"


@dataclass
class FakeMountEntry:
    prefix: str
    vfs: object
    cache_manager: object = None
    accessor: Accessor = field(default_factory=Accessor)


@dataclass
class FakeRegistry:
    entry: FakeMountEntry

    def mount_for(self, path: str) -> FakeMountEntry:
        return self.entry


def _change(kind, virtual):
    return FileEvent(
        kind=kind, path=PathSpec.from_str_path(virtual), timestamp=_TS
    )


def _hub(log=None):
    manager = FakeCacheManager(log) if log is not None else None
    entry = FakeMountEntry(
        prefix="/nc/", vfs=PlainVFS(), cache_manager=manager
    )
    return EventHub(FakeRegistry(entry))


async def _start_blocked_events(hub, virtual="/nc"):
    """Start an events iterator and let it register + block on pop.

    Returns the generator and the pending __anext__ task, so a test can
    inject via notify() and then await the delivery.
    """
    agen = hub.events(PathSpec.from_str_path(virtual))
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    return agen, task


@pytest.mark.asyncio
async def test_notify_delivers_change():
    hub = _hub()
    agen, task = await _start_blocked_events(hub)
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.kind is FileChangeKind.CREATE
    assert change.path.virtual == "/nc/data/x.txt"
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_notify_invalidate_before_deliver():
    log: list[str] = []
    hub = _hub(log=log)
    agen, task = await _start_blocked_events(hub)
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
    await asyncio.wait_for(task, timeout=2)
    log.append("deliver")
    assert log == ["create:/nc/data/x.txt", "deliver"]
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_a_nested_create_drops_every_listing_to_the_mount_root():
    # A nested external create implies intermediate dirs appeared, so
    # every cached listing up to the mount root must go, not just the
    # file's immediate parent. Asserted against a real CacheManager
    # rather than the fake above, because the walk itself lives there
    # now and a fake would only prove the call was made.
    index = RAMIndexCacheStore()
    levels = ("/nc", "/nc/data", "/nc/data/sub")
    for level in levels:
        await index.set_dir(
            level,
            [
                (
                    "child",
                    FileStat(
                        name="child", type=FileType.FILE, fingerprint="1"
                    ),
                )
            ],
        )
    entry = FakeMountEntry(
        prefix="/nc/",
        vfs=PlainVFS(),
        cache_manager=CacheManager(None, index, "/nc/", False),
    )
    hub = EventHub(FakeRegistry(entry))
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/sub/deep.txt"))
    for level in levels:
        assert (await index.list_dir(level)).entries is None
    await hub.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [FileChangeKind.DELETE, FileChangeKind.UNKNOWN, FileChangeKind.UPDATE],
)
async def test_notify_hands_its_kind_to_the_manager(kind):
    log: list[str] = []
    hub = _hub(log=log)
    agen, task = await _start_blocked_events(hub)
    await hub.notify(_change(kind, "/nc/data/day"))
    await asyncio.wait_for(task, timeout=2)
    assert log == [f"{kind}:/nc/data/day"]
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_notify_reframes_vfs_path():
    seen: list[str] = []

    class RecordingManager:
        async def invalidate(self, path, kind):
            seen.append(path.vfs_path)

    entry = FakeMountEntry(
        prefix="/nc/", vfs=PlainVFS(), cache_manager=RecordingManager()
    )
    hub = EventHub(FakeRegistry(entry))
    agen, task = await _start_blocked_events(hub)
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
    await asyncio.wait_for(task, timeout=2)
    assert seen == ["data/x.txt"]
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_notify_move_evicts_both_sides():
    # The vacated old path must be evicted as a removal, or a consumer
    # could cat the old path and get stale cached bytes.
    log: list[str] = []
    hub = _hub(log=log)
    agen, task = await _start_blocked_events(hub)
    move = FileEvent(
        kind=FileChangeKind.MOVE,
        path=PathSpec.from_str_path("/nc/data/new.txt"),
        previous_path=PathSpec.from_str_path("/nc/old/orig.txt"),
        timestamp=_TS,
    )
    await hub.notify(move)
    await asyncio.wait_for(task, timeout=2)
    assert log == ["move:/nc/data/new.txt", "delete:/nc/old/orig.txt"]
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_failed_removal_cleans_ancestors_without_delivery():
    cache = RAMFileCacheStore()
    index = RAMIndexCacheStore()
    levels = ("/old", "/old/a", "/old/a/b", "/old/a/b/f")
    for directory in levels:
        await index.set_dir(directory, [])
    await cache.set("/old/a/b/f", b"old")
    old = FakeMountEntry(
        "/old/", PlainVFS(), CacheManager(cache, index, "/old/", True)
    )
    hub = EventHub(FakeRegistry(old))
    event = _change(FileChangeKind.DELETE, "/old/a/b/f")
    stream, pending = await _start_blocked_events(hub, "/old")
    error = RuntimeError("registry recovery failed")
    try:
        with (
            patch.object(index, "holds_subtree", AsyncMock(side_effect=error)),
            patch.object(
                RAMEventQueue, "push", new_callable=AsyncMock
            ) as pushed,
        ):
            with pytest.raises(RuntimeError) as caught:
                await hub.notify(event)
            pushed.assert_not_awaited()
        assert caught.value is error
        assert not pending.done()
        assert await cache.exists("/old/a/b/f") is False
        for directory in levels:
            assert (await index.list_dir(directory)).entries is None
    finally:
        await hub.close()
        try:
            with pytest.raises(StopAsyncIteration):
                await pending
        finally:
            await stream.aclose()


class _Keeping(Accessor):
    def __init__(self, answers: ResponseCache[str, str]) -> None:
        self.answers = answers

    def caches(self) -> tuple[ResponseCache[str, str]]:
        return (self.answers,)


@pytest.mark.asyncio
async def test_notify_drops_the_answers_the_client_keeps_of_its_own():
    # An event is often the only word that the service changed, and no
    # path names a client's own answers (a repository's tree, a
    # database's names), so they answered the old service until the
    # mount dropped its caches for some other reason.
    answers: ResponseCache[str, str] = ResponseCache()
    entry = FakeMountEntry(
        prefix="/nc/", vfs=PlainVFS(), accessor=_Keeping(answers)
    )
    hub = EventHub(FakeRegistry(entry))

    async def before() -> str:
        return "before"

    async def after() -> str:
        return "after"

    await answers.get("names", before)
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/new.txt"))
    assert await answers.get("names", after) == "after"
    await hub.close()


@pytest.mark.asyncio
async def test_notify_fans_out_to_all_matching_subscriptions():
    hub = _hub()
    a_gen, a_task = await _start_blocked_events(hub)
    b_gen, b_task = await _start_blocked_events(hub)
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
    a = await asyncio.wait_for(a_task, timeout=2)
    b = await asyncio.wait_for(b_task, timeout=2)
    assert a.path.virtual == b.path.virtual == "/nc/data/x.txt"
    await a_gen.aclose()
    await b_gen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_notify_skips_out_of_scope_subscription():
    hub = _hub()
    agen, task = await _start_blocked_events(hub, virtual="/nc/other")
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/x.txt"))
    await asyncio.sleep(0.05)
    assert not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_plain_vfs_delivers_events():
    # No delta_hook capability required: delivery is notify-driven.
    hub = _hub()
    agen, task = await _start_blocked_events(hub)
    await hub.notify(_change(FileChangeKind.UPDATE, "/nc/a.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.kind is FileChangeKind.UPDATE
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_close_ends_blocked_iterator():
    hub = _hub()
    agen, task = await _start_blocked_events(hub)
    await hub.close()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(task, timeout=2)
    await agen.aclose()


@pytest.mark.asyncio
async def test_notify_after_close_is_noop():
    hub = _hub()
    await hub.close()
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    assert hub._subscribers == []


def test_matches_literal_root_is_whole_subtree():
    hub = _hub()
    sub = Subscriber(queue=None, roots=("/nc",))
    assert hub._matches(sub, _change(FileChangeKind.CREATE, "/nc/top.txt"))
    assert hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/sub/deep.txt")
    )
    assert not hub._matches(
        sub, _change(FileChangeKind.CREATE, "/other/x.txt")
    )


def test_matches_glob_scope_one_level():
    hub = _hub()
    sub = Subscriber(queue=None, roots=("/nc/data/*.txt",))
    assert hub._matches(sub, _change(FileChangeKind.CREATE, "/nc/data/a.txt"))
    assert not hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/a.md")
    )
    assert not hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/sub/a.txt")
    )


def test_matches_slashless_glob_is_shallow():
    # GNU depth semantics: /nc/data/* is the entries themselves —
    # the glob spelling of a shallow subscription, no descent.
    hub = _hub()
    sub = Subscriber(queue=None, roots=("/nc/data/*",))
    assert hub._matches(sub, _change(FileChangeKind.CREATE, "/nc/data/a.txt"))
    assert hub._matches(sub, _change(FileChangeKind.CREATE, "/nc/data/sub"))
    assert not hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/sub/deep.txt")
    )


def test_matches_trailing_slash_glob_scopes_dir_subtrees():
    # GNU */ matches directories only; the subscription scope is everything
    # strictly inside them.
    hub = _hub()
    sub = Subscriber(queue=None, roots=("/nc/data/*/",))
    assert hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/sub/deep.txt")
    )
    assert hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/sub/nested/x.txt")
    )
    assert not hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/top.txt")
    )


def test_matches_glob_scope_covers_matched_dirs():
    hub = _hub()
    sub = Subscriber(queue=None, roots=("/nc/data/sub*/",))
    assert hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/subdir/deep.txt")
    )
    assert not hub._matches(
        sub, _change(FileChangeKind.CREATE, "/nc/data/x.txt")
    )
    shallow = Subscriber(queue=None, roots=("/nc/data/sub*",))
    assert hub._matches(
        shallow, _change(FileChangeKind.CREATE, "/nc/data/subdir")
    )
    assert not hub._matches(
        shallow, _change(FileChangeKind.CREATE, "/nc/data/subdir/deep.txt")
    )


def test_matches_glob_middle_wildcard_fine_grained():
    # /nc/data/*/abc/: everything inside any project dir's abc;
    # /nc/data/*/abc (no slash): the abc entries themselves.
    hub = _hub()
    inside = Subscriber(queue=None, roots=("/nc/data/*/abc/",))
    assert hub._matches(
        inside, _change(FileChangeKind.CREATE, "/nc/data/proj1/abc/report.txt")
    )
    assert hub._matches(
        inside, _change(FileChangeKind.CREATE, "/nc/data/proj1/abc/deep/x.txt")
    )
    assert not hub._matches(
        inside, _change(FileChangeKind.CREATE, "/nc/data/proj1/other.txt")
    )
    assert not hub._matches(
        inside, _change(FileChangeKind.CREATE, "/nc/data/abc")
    )
    entry = Subscriber(queue=None, roots=("/nc/data/*/abc",))
    assert hub._matches(
        entry, _change(FileChangeKind.CREATE, "/nc/data/proj1/abc")
    )
    assert not hub._matches(
        entry, _change(FileChangeKind.CREATE, "/nc/data/proj1/abc/report.txt")
    )


def test_matches_any_of_multiple_roots():
    hub = _hub()
    sub = Subscriber(queue=None, roots=("/nc/a", "/nc/b/keep.txt"))
    assert hub._matches(sub, _change(FileChangeKind.UPDATE, "/nc/a/x.txt"))
    assert hub._matches(sub, _change(FileChangeKind.UPDATE, "/nc/b/keep.txt"))
    assert not hub._matches(
        sub, _change(FileChangeKind.UPDATE, "/nc/b/other.txt")
    )


@pytest.mark.asyncio
async def test_events_accepts_path_list():
    hub = _hub()
    paths = [
        PathSpec.from_str_path("/nc/a"),
        PathSpec.from_str_path("/nc/b"),
    ]
    agen = hub.events(paths)
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/b/y.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.path.virtual == "/nc/b/y.txt"
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_events_preserves_trailing_slash_scope():
    # The trailing slash must survive subscription framing: /nc/data/*/
    # scopes inside child dirs, and framing must not collapse it to
    # the shallow /nc/data/* form.
    hub = _hub()
    agen, task = await _start_blocked_events(hub, virtual="/nc/data/*/")
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/top.txt"))
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/sub/deep.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.path.virtual == "/nc/data/sub/deep.txt"
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_events_glob_delivers_only_matches():
    hub = _hub()
    agen, task = await _start_blocked_events(hub, virtual="/nc/data/*.txt")
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/skip.md"))
    await hub.notify(_change(FileChangeKind.CREATE, "/nc/data/hit.txt"))
    change = await asyncio.wait_for(task, timeout=2)
    assert change.path.virtual == "/nc/data/hit.txt"
    await agen.aclose()
    await hub.close()


@pytest.mark.asyncio
async def test_events_empty_path_list_raises():
    hub = _hub()
    agen = hub.events([])
    with pytest.raises(ValueError):
        await agen.__anext__()
    await hub.close()


def _real_hub() -> tuple[EventHub, RAMFileCacheStore, RAMIndexCacheStore]:
    cache = RAMFileCacheStore()
    index = RAMIndexCacheStore(ttl=600)
    entry = FakeMountEntry(
        prefix="/x/",
        vfs=PlainVFS(),
        cache_manager=CacheManager(cache, index, "/x/", True),
    )
    return EventHub(FakeRegistry(entry)), cache, index


def _row(name: str, kind: str = "file") -> FileStat:
    folder = kind == "folder"
    return FileStat(
        name=name, type=FileType.DIRECTORY if folder else FileType.FILE
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [FileChangeKind.DELETE, FileChangeKind.MOVE])
async def test_removing_a_folder_drops_its_cached_subtree(kind):
    hub, cache, index = _real_hub()
    try:
        await index.set_dir("/x/dir/sub", [("f", _row("f"))])
        await cache.set("/x/dir/sub/f", b"old\n")
        await hub.notify(
            FileEvent(
                kind=kind,
                path=PathSpec.from_str_path(
                    "/x/moved" if kind is FileChangeKind.MOVE else "/x/dir"
                ),
                previous_path=PathSpec.from_str_path("/x/dir")
                if kind is FileChangeKind.MOVE
                else None,
                timestamp=_TS,
            )
        )
        assert (
            await index.list_dir("/x/dir/sub")
        ).status == LookupStatus.NOT_FOUND
        assert await cache.exists("/x/dir/sub/f") is False
    finally:
        await hub.close()


@pytest.mark.asyncio
async def test_a_same_parent_rename_still_finds_the_folders_listing():
    # The target is evicted first, which buries /x and pops the folder's
    # row; the folder's own listing must still be found after that.
    hub, cache, index = _real_hub()
    await index.set_dir(
        "/x", [("dir", _row("dir", "folder")), ("s", _row("s"))]
    )
    await index.set_dir("/x/dir", [("f", _row("f"))])
    await cache.set("/x/dir/f", b"old\n")
    await hub.notify(
        FileEvent(
            kind=FileChangeKind.MOVE,
            path=PathSpec.from_str_path("/x/renamed"),
            previous_path=PathSpec.from_str_path("/x/dir"),
            timestamp=_TS,
        )
    )
    assert await cache.exists("/x/dir/f") is False
    await hub.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("paths", "expected"),
    [
        (("/x/t/s1/f", "/x/t/s1", "/x/t"), 2),
        (("/x/t", "/x/t/s1", "/x/t/s1/f"), 1),
    ],
    ids=["children-first", "folder-first"],
)
async def test_delete_stream_drops_only_retained_subtrees(paths, expected):
    hub, cache, index = _real_hub()
    try:
        await index.set_dir("/x/t", [("s1", _row("s1", "folder"))])
        await index.set_dir("/x/t/s1", [("f", _row("f"))])
        await cache.set("/x/t/s1/f", b"f")
        with (
            patch.object(cache, "remove", wraps=cache.remove) as evict,
            patch.object(
                index, "invalidate_prefix", wraps=index.invalidate_prefix
            ) as drop,
        ):
            for path in paths:
                await hub.notify(_change(FileChangeKind.DELETE, path))
        assert (
            sum(bool(c.kwargs.get("subtree")) for c in evict.call_args_list)
            == expected
        )
        assert drop.call_count == expected
        assert (await index.list_dir("/x/t")).status == LookupStatus.NOT_FOUND
        assert (
            await index.list_dir("/x/t/s1")
        ).status == LookupStatus.NOT_FOUND
        assert await index.holds_subtree("/x/t") is False
        assert await cache.exists("/x/t/s1/f") is False
    finally:
        await hub.close()
