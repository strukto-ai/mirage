import asyncio
import os
from pathlib import Path

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.watch.walk import DiskWalk, build_delta_hook
from mirage.types import FileChangeKind, PathSpec


def _accessor(root: Path) -> DiskAccessor:
    return DiskAccessor(root)


def _root(virtual: str, resource_path: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=resource_path)


def _touch(root: Path, relative: str, body: bytes, mtime: float) -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    os.utime(target, (mtime, mtime))


async def _collect(walk, root):
    return [entry async for entry in walk(root)]


def test_walk_reports_files_and_directories(tmp_path):
    _touch(tmp_path, "data/a.txt", b"alpha", 1_700_000_000)
    _touch(tmp_path, "data/sub/deep.txt", b"deep", 1_700_000_000)
    entries = asyncio.run(
        _collect(DiskWalk(_accessor(tmp_path)), _root("/d/data", "data")))
    files = {e.virtual for e in entries if not e.is_dir}
    dirs = {e.virtual for e in entries if e.is_dir}
    assert files == {"/d/data/a.txt", "/d/data/sub/deep.txt"}
    assert dirs == {"/d/data/sub"}


def test_walk_carries_size_and_mtime(tmp_path):
    _touch(tmp_path, "data/a.txt", b"alpha", 1_700_000_000)
    entries = asyncio.run(
        _collect(DiskWalk(_accessor(tmp_path)), _root("/d/data", "data")))
    entry = next(e for e in entries if not e.is_dir)
    assert entry.size == 5
    assert entry.modified is not None
    assert entry.fingerprint == f"{entry.modified}|5"


def test_missing_root_walks_empty(tmp_path):
    entries = asyncio.run(
        _collect(DiskWalk(_accessor(tmp_path)), _root("/d/gone", "gone")))
    assert entries == []


def test_baseline_then_create_update_delete(tmp_path):
    _touch(tmp_path, "data/a.txt", b"alpha", 1_700_000_000)
    _touch(tmp_path, "data/b.txt", b"beta", 1_700_000_000)
    hook = build_delta_hook(_accessor(tmp_path))
    root = _root("/d/data", "data")
    first = asyncio.run(hook.pull(root, None))
    assert first.changes == ()

    _touch(tmp_path, "data/a.txt", b"gamma", 1_700_000_500)
    _touch(tmp_path, "data/c.txt", b"new", 1_700_000_500)
    (tmp_path / "data/b.txt").unlink()

    second = asyncio.run(hook.pull(root, first.checkpoint))
    by_path = {c.path.virtual: c.kind for c in second.changes}
    assert by_path == {
        "/d/data/a.txt": FileChangeKind.UPDATE,
        "/d/data/c.txt": FileChangeKind.CREATE,
        "/d/data/b.txt": FileChangeKind.DELETE,
    }


def test_untouched_tree_reports_nothing(tmp_path):
    _touch(tmp_path, "data/a.txt", b"alpha", 1_700_000_000)
    hook = build_delta_hook(_accessor(tmp_path))
    root = _root("/d/data", "data")
    first = asyncio.run(hook.pull(root, None))
    second = asyncio.run(hook.pull(root, first.checkpoint))
    assert second.changes == ()


def test_new_directory_is_reported(tmp_path):
    _touch(tmp_path, "data/a.txt", b"alpha", 1_700_000_000)
    hook = build_delta_hook(_accessor(tmp_path))
    root = _root("/d/data", "data")
    first = asyncio.run(hook.pull(root, None))
    (tmp_path / "data" / "fresh").mkdir()
    second = asyncio.run(hook.pull(root, first.checkpoint))
    assert [(c.kind, c.path.virtual) for c in second.changes
            ] == [(FileChangeKind.CREATE, "/d/data/fresh")]


def test_changed_path_carries_the_mount_framing(tmp_path):
    _touch(tmp_path, "data/a.txt", b"alpha", 1_700_000_000)
    hook = build_delta_hook(_accessor(tmp_path))
    root = _root("/d/data", "data")
    first = asyncio.run(hook.pull(root, None))
    _touch(tmp_path, "data/a.txt", b"gamma", 1_700_000_500)
    second = asyncio.run(hook.pull(root, first.checkpoint))
    changed = second.changes[0].path
    assert changed.virtual == "/d/data/a.txt"
    assert changed.resource_path == "data/a.txt"


def test_missing_root_reports_nothing(tmp_path):
    entries = asyncio.run(
        _collect(DiskWalk(_accessor(tmp_path)), _root("/d/gone", "gone")))
    assert entries == []


def test_unreadable_directory_aborts_rather_than_reporting_empty(tmp_path):
    # An unreadable subtree is not an empty one. Swallowing the error
    # diffs into a DELETE for every child, then a CREATE for each once
    # access returns, so the walk fails and the checkpoint stands.
    _touch(tmp_path, "data/a.txt", b"alpha", 1_700_000_000)
    locked = tmp_path / "data" / "locked"
    locked.mkdir()
    (locked / "inner.txt").write_bytes(b"inner")
    locked.chmod(0o000)
    try:
        with pytest.raises(PermissionError):
            asyncio.run(
                _collect(DiskWalk(_accessor(tmp_path)),
                         _root("/d/data", "data")))
    finally:
        locked.chmod(0o755)
