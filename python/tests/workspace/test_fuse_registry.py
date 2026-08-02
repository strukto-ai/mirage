import subprocess

import pytest

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource


class _FakeThread:

    def __init__(self):
        self.alive = True


def _fake_mount(monkeypatch):
    monkeypatch.setattr("mirage.workspace.fuse.mount_background",
                        lambda ops, mountpoint, root_prefix="", session=None,
                        backend=None: _FakeThread())
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)


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


def test_register_one_mount_exposes_singular(monkeypatch):
    _fake_mount(monkeypatch)
    with _ws() as ws:
        ws.add_fuse_mount("/a/", "/tmp/mp-a")
        assert ws.fuse_mountpoints == {"/a/": "/tmp/mp-a"}
        assert ws.fuse_mountpoint == "/tmp/mp-a"


def test_register_two_distinct_paths_singular_raises(monkeypatch):
    _fake_mount(monkeypatch)
    with _ws() as ws:
        ws.add_fuse_mount("/a/", "/tmp/mp-a")
        ws.add_fuse_mount("/b/", "/tmp/mp-b")
        assert set(ws.fuse_mountpoints) == {"/a/", "/b/"}
        with pytest.raises(RuntimeError):
            _ = ws.fuse_mountpoint


def test_register_colliding_path_raises(monkeypatch):
    _fake_mount(monkeypatch)
    with _ws() as ws:
        ws.add_fuse_mount("/a/", "/tmp/same")
        with pytest.raises(ValueError):
            ws.add_fuse_mount("/b/", "/tmp/same")


def test_deregister_removes_entry(monkeypatch):
    _fake_mount(monkeypatch)
    with _ws() as ws:
        ws.add_fuse_mount("/a/", "/tmp/mp-a")
        ws.remove_fuse_mount("/a/")
        assert ws.fuse_mountpoints == {}
        assert ws.fuse_mountpoint is None
