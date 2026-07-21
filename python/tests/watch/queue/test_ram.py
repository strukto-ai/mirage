from datetime import datetime, timezone

import pytest

from mirage.types import FileChangeKind, FileEvent, PathSpec
from mirage.watch.queue import (OverflowPolicy, QueueOverflowError,
                                RAMWatchQueue)

_TS = datetime.fromtimestamp(0, tz=timezone.utc)


def _change(kind: FileChangeKind, virtual: str) -> FileEvent:
    return FileEvent(kind=kind,
                     path=PathSpec.from_str_path(virtual),
                     timestamp=_TS)


def _root() -> PathSpec:
    return PathSpec.from_str_path("/nc")


@pytest.mark.asyncio
async def test_push_pop_single():
    q = RAMWatchQueue(_root())
    await q.push(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    change = await q.pop()
    assert change.kind is FileChangeKind.CREATE
    assert change.path.virtual == "/nc/a.txt"
    assert await q.pending() == 0


@pytest.mark.asyncio
async def test_coalesce_create_then_update_stays_create():
    q = RAMWatchQueue(_root())
    await q.push(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    await q.push(_change(FileChangeKind.UPDATE, "/nc/a.txt"))
    assert await q.pending() == 1
    change = await q.pop()
    assert change.kind is FileChangeKind.CREATE


@pytest.mark.asyncio
async def test_coalesce_create_then_delete_cancels():
    q = RAMWatchQueue(_root())
    await q.push(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    await q.push(_change(FileChangeKind.DELETE, "/nc/a.txt"))
    assert await q.pending() == 0


@pytest.mark.asyncio
async def test_coalesce_update_then_delete_is_delete():
    q = RAMWatchQueue(_root())
    await q.push(_change(FileChangeKind.UPDATE, "/nc/a.txt"))
    await q.push(_change(FileChangeKind.DELETE, "/nc/a.txt"))
    change = await q.pop()
    assert change.kind is FileChangeKind.DELETE


@pytest.mark.asyncio
async def test_coalesce_delete_then_create_is_update():
    q = RAMWatchQueue(_root())
    await q.push(_change(FileChangeKind.DELETE, "/nc/a.txt"))
    await q.push(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    change = await q.pop()
    assert change.kind is FileChangeKind.UPDATE


@pytest.mark.asyncio
async def test_distinct_paths_do_not_coalesce():
    q = RAMWatchQueue(_root())
    await q.push(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    await q.push(_change(FileChangeKind.CREATE, "/nc/b.txt"))
    assert await q.pending() == 2


@pytest.mark.asyncio
async def test_overflow_collapse_to_unknown_root():
    q = RAMWatchQueue(_root(),
                      max_pending=2,
                      on_overflow=OverflowPolicy.COLLAPSE)
    for i in range(3):
        await q.push(_change(FileChangeKind.CREATE, f"/nc/f{i}.txt"))
    assert await q.pending() == 1
    change = await q.pop()
    assert change.kind is FileChangeKind.UNKNOWN
    assert change.path.virtual == "/nc"


@pytest.mark.asyncio
async def test_overflow_drop_oldest_keeps_cap():
    q = RAMWatchQueue(_root(),
                      max_pending=2,
                      on_overflow=OverflowPolicy.DROP_OLDEST)
    for i in range(4):
        await q.push(_change(FileChangeKind.CREATE, f"/nc/f{i}.txt"))
    assert await q.pending() == 2


@pytest.mark.asyncio
async def test_overflow_error_raises_on_pop():
    q = RAMWatchQueue(_root(), max_pending=1, on_overflow=OverflowPolicy.ERROR)
    await q.push(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    await q.push(_change(FileChangeKind.CREATE, "/nc/b.txt"))
    with pytest.raises(QueueOverflowError):
        await q.pop()


@pytest.mark.asyncio
async def test_clear_empties_pending():
    q = RAMWatchQueue(_root())
    await q.push(_change(FileChangeKind.CREATE, "/nc/a.txt"))
    await q.clear()
    assert await q.pending() == 0
