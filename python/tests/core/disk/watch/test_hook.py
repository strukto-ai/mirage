import asyncio
import os
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.watch.hook import DiskEventHook
from mirage.types import FileChangeKind, PathSpec


def _accessor(root: Path) -> DiskAccessor:
    return DiskAccessor(root)


def _root(virtual: str, vfs_path: str) -> PathSpec:
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=vfs_path)


def _touch(root: Path, relative: str, body: bytes, mtime: float) -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    os.utime(target, (mtime, mtime))


async def _collect(walk, root):
    return [entry async for entry in walk(root)]


def _map(tmp_path, event_type, payload):
    hook = DiskEventHook(_accessor(tmp_path))
    return asyncio.run(
        hook.to_events(_root("/d/data", "data"), event_type, payload))


def test_event_hook_maps_a_create_to_the_virtual_path(tmp_path):
    events = _map(tmp_path, "created",
                  {"src_path": str(tmp_path / "data" / "a.txt")})
    assert len(events) == 1
    assert events[0].kind is FileChangeKind.CREATE
    assert events[0].path.virtual == "/d/data/a.txt"
    assert events[0].path.vfs_path == "data/a.txt"


def test_event_hook_maps_modified_and_deleted(tmp_path):
    target = str(tmp_path / "data" / "a.txt")
    assert _map(tmp_path, "modified",
                {"src_path": target})[0].kind is FileChangeKind.UPDATE
    assert _map(tmp_path, "deleted",
                {"src_path": target})[0].kind is FileChangeKind.DELETE


def test_event_hook_maps_a_move_to_both_sides(tmp_path):
    events = _map(
        tmp_path, "moved", {
            "src_path": str(tmp_path / "data" / "old.txt"),
            "dest_path": str(tmp_path / "data" / "new.txt"),
        })
    assert events[0].kind is FileChangeKind.MOVE
    assert events[0].path.virtual == "/d/data/new.txt"
    assert events[0].previous_path is not None
    assert events[0].previous_path.virtual == "/d/data/old.txt"


def test_event_hook_reports_a_move_out_of_the_mount_as_a_delete(tmp_path):
    events = _map(
        tmp_path, "moved", {
            "src_path": str(tmp_path / "data" / "old.txt"),
            "dest_path": "/elsewhere/new.txt",
        })
    assert events[0].kind is FileChangeKind.DELETE
    assert events[0].path.virtual == "/d/data/old.txt"


def test_event_hook_ignores_a_path_outside_the_mount(tmp_path):
    assert _map(tmp_path, "created", {"src_path": "/elsewhere/a.txt"}) == ()


def test_event_hook_ignores_an_unknown_event_type(tmp_path):
    assert _map(tmp_path, "opened",
                {"src_path": str(tmp_path / "data" / "a.txt")}) == ()


def test_event_hook_ignores_a_payload_without_a_path(tmp_path):
    assert _map(tmp_path, "created", {"nothing": "here"}) == ()
    assert _map(tmp_path, "created", "not-an-object") == ()


def test_event_hook_reports_a_move_into_the_mount_as_a_create(tmp_path):
    # A watcher rooted above the mount sees the source as out of scope;
    # discarding the whole event would leave the arrival invisible.
    events = _map(
        tmp_path, "moved", {
            "src_path": "/elsewhere/old.txt",
            "dest_path": str(tmp_path / "data" / "new.txt"),
        })
    assert events[0].kind is FileChangeKind.CREATE
    assert events[0].path.virtual == "/d/data/new.txt"
    assert events[0].previous_path is None


def test_event_hook_ignores_a_move_that_touches_neither_side(tmp_path):
    assert _map(tmp_path, "moved", {
        "src_path": "/elsewhere/old.txt",
        "dest_path": "/nowhere/new.txt",
    }) == ()


def test_event_hook_normalizes_the_mount_root(tmp_path):
    events = _map(tmp_path, "modified", {"src_path": str(tmp_path)})
    assert events[0].path.virtual == "/d"
    assert events[0].path.vfs_path == ""
