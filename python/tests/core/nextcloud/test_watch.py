import pytest

from mirage.core.nextcloud.watch import NextcloudWalk, build_delta_hook
from mirage.types import FileChangeKind, PathSpec


def _root() -> PathSpec:
    return PathSpec.from_str_path("/")


@pytest.mark.asyncio
async def test_walk_yields_files_and_dirs(make_acc):
    acc = make_acc({"data/a.txt": b"x", "data/sub/b.txt": b"yy"})
    walk = NextcloudWalk(acc)
    entries = {e.virtual: e async for e in walk(_root())}
    assert "/data/a.txt" in entries
    assert "/data/sub/b.txt" in entries
    assert entries["/data"].is_dir
    assert not entries["/data/a.txt"].is_dir
    assert entries["/data/a.txt"].fingerprint is not None


@pytest.mark.asyncio
async def test_walk_detector_prefers_etag(make_acc):
    acc = make_acc({"data/a.txt": b"x"})
    walk = NextcloudWalk(acc)
    entries = {e.virtual: e async for e in walk(_root())}
    assert entries["/data/a.txt"].fingerprint == "etag-data/a.txt"


@pytest.mark.asyncio
async def test_hook_baseline_then_create(make_acc):
    acc = make_acc({"data/a.txt": b"x"})
    hook = build_delta_hook(acc)
    base = await hook.pull(_root(), None)
    assert base.changes == ()
    await acc._fake.write("data/b.txt", b"new")
    delta = await hook.pull(_root(), base.checkpoint)
    created = {c.path.virtual: c for c in delta.changes}
    assert "/data/b.txt" in created
    assert created["/data/b.txt"].kind is FileChangeKind.CREATE


@pytest.mark.asyncio
async def test_hook_detects_update(make_acc):
    acc = make_acc({"data/a.txt": b"x"})
    hook = build_delta_hook(acc)
    base = await hook.pull(_root(), None)
    await acc._fake.write("data/a.txt", b"changed-content")
    delta = await hook.pull(_root(), base.checkpoint)
    changed = {c.path.virtual: c for c in delta.changes}
    assert changed["/data/a.txt"].kind is FileChangeKind.UPDATE


@pytest.mark.asyncio
async def test_hook_detects_delete(make_acc):
    acc = make_acc({"data/a.txt": b"x", "data/b.txt": b"y"})
    hook = build_delta_hook(acc)
    base = await hook.pull(_root(), None)
    await acc._fake.delete("data/b.txt")
    delta = await hook.pull(_root(), base.checkpoint)
    deleted = {c.path.virtual: c for c in delta.changes}
    assert deleted["/data/b.txt"].kind is FileChangeKind.DELETE
