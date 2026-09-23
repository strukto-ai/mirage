import asyncio

import pytest

from mirage.core.disk.watch import DiskEventHook
from mirage.types import FileChangeKind, MountMode, PathSpec
from mirage.vfs.disk import DiskVFS
from mirage.watch.events import event_at
from mirage.workspace import Workspace


def _root() -> PathSpec:
    return PathSpec(virtual="/d", directory="/d", vfs_path="")


async def _ws(tmp_path) -> Workspace:
    return Workspace({"/d": (DiskVFS(root=str(tmp_path)), MountMode.READ)},
                     mode=MountMode.READ)


@pytest.mark.asyncio
async def test_mapped_event_makes_the_next_read_fresh(tmp_path):
    (tmp_path / "day").mkdir()
    (tmp_path / "day" / "chat.jsonl").write_text("one\n")
    ws = await _ws(tmp_path)
    warm = await ws.shell("cat /d/day/chat.jsonl")
    assert await warm.stdout_str() == "one\n"

    (tmp_path / "day" / "chat.jsonl").write_text("one\ntwo\n")
    hook = DiskEventHook(ws.registry.mount_for("/d").vfs.accessor)
    body = {"src_path": str(tmp_path / "day" / "chat.jsonl")}
    for change in await hook.to_events(_root(), "modified", body):
        await ws.notify(change)

    fresh = await ws.shell("cat /d/day/chat.jsonl")
    assert await fresh.stdout_str() == "one\ntwo\n"
    await ws.close()


@pytest.mark.asyncio
async def test_mapped_create_appears_in_a_warm_listing(tmp_path):
    (tmp_path / "day").mkdir()
    (tmp_path / "day" / "a.txt").write_text("a")
    ws = await _ws(tmp_path)
    assert "a.txt" in await (await ws.shell("ls /d/day")).stdout_str()

    (tmp_path / "day" / "b.txt").write_text("b")
    hook = DiskEventHook(ws.registry.mount_for("/d").vfs.accessor)
    for change in await hook.to_events(
            _root(), "created", {"src_path": str(tmp_path / "day" / "b.txt")}):
        await ws.notify(change)

    assert "b.txt" in await (await ws.shell("ls /d/day")).stdout_str()
    await ws.close()


@pytest.mark.asyncio
async def test_unknown_on_a_directory_refreshes_the_whole_subtree(tmp_path):
    (tmp_path / "day" / "files").mkdir(parents=True)
    (tmp_path / "day" / "files" / "a.png").write_bytes(b"png")
    ws = await _ws(tmp_path)
    assert "a.png" in await (await ws.shell("ls /d/day/files")).stdout_str()

    (tmp_path / "day" / "files" / "b.png").write_bytes(b"png")
    await ws.notify(event_at(_root(), "day", FileChangeKind.UNKNOWN))

    listing = await (await ws.shell("ls /d/day/files")).stdout_str()
    assert "b.png" in listing
    await ws.close()


@pytest.mark.asyncio
async def test_a_scoped_event_is_delivered_to_a_matching_watch(tmp_path):
    (tmp_path / "day").mkdir()
    ws = await _ws(tmp_path)
    agen = ws.watch("/d/day")
    task = asyncio.ensure_future(agen.__anext__())
    await asyncio.sleep(0.03)

    hook = DiskEventHook(ws.registry.mount_for("/d").vfs.accessor)
    for change in await hook.to_events(
            _root(), "created", {"src_path": str(tmp_path / "day" / "c.txt")}):
        await ws.notify(change)

    got = await asyncio.wait_for(task, timeout=2)
    assert got.kind is FileChangeKind.CREATE
    assert got.path.virtual == "/d/day/c.txt"
    await agen.aclose()
    await ws.close()
