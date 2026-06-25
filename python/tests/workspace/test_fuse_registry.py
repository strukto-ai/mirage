import pytest

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource


def _ws():
    return Workspace({
        "/a/": RAMResource(),
        "/b/": RAMResource()
    },
                     mode=MountMode.WRITE)


def test_no_fuse_mounts_returns_empty_and_none():
    with _ws() as ws:
        assert ws.fuse_mountpoints == {}
        assert ws.fuse_mountpoint is None


def test_register_one_mount_exposes_singular():
    with _ws() as ws:
        ws._register_fuse("/a/", "/tmp/mp-a")
        assert ws.fuse_mountpoints == {"/a/": "/tmp/mp-a"}
        assert ws.fuse_mountpoint == "/tmp/mp-a"


def test_register_two_distinct_paths_singular_raises():
    with _ws() as ws:
        ws._register_fuse("/a/", "/tmp/mp-a")
        ws._register_fuse("/b/", "/tmp/mp-b")
        assert set(ws.fuse_mountpoints) == {"/a/", "/b/"}
        with pytest.raises(RuntimeError):
            _ = ws.fuse_mountpoint


def test_register_colliding_path_raises():
    with _ws() as ws:
        ws._register_fuse("/a/", "/tmp/same")
        with pytest.raises(ValueError):
            ws._register_fuse("/b/", "/tmp/same")


def test_deregister_removes_entry():
    with _ws() as ws:
        ws._register_fuse("/a/", "/tmp/mp-a")
        ws._deregister_fuse("/a/")
        assert ws.fuse_mountpoints == {}
        assert ws.fuse_mountpoint is None
