import subprocess
import sys
from unittest.mock import Mock

import pytest

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS


class _FakeThread:
    def __init__(self):
        self.alive = True


def _fake_mount(monkeypatch):
    monkeypatch.setattr(
        "mirage.workspace.fuse.mount_background",
        lambda *_args, **_kwargs: _FakeThread(),
    )
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "mirage.workspace.fuse.unmount_with_fusermount",
        lambda _mountpoint: None,
    )


def _ws():
    return Workspace({"/a/": RAMVFS(), "/b/": RAMVFS()}, mode=MountMode.WRITE)


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


def test_failed_removal_keeps_entry_for_a_retry(monkeypatch):
    _fake_mount(monkeypatch)
    with _ws() as ws:
        ws.add_fuse_mount("/a/", "/tmp/mp-a")
        monkeypatch.setattr(sys, "platform", "linux")
        monkeypatch.setattr(
            "mirage.workspace.fuse.unmount_with_fusermount",
            Mock(side_effect=[OSError("busy"), None]),
        )
        with pytest.raises(OSError, match="busy"):
            ws.remove_fuse_mount("/a/")
        assert ws.fuse_mountpoints == {"/a/": "/tmp/mp-a"}
        ws.remove_fuse_mount("/a/")
        assert ws.fuse_mountpoints == {}


def test_removal_keeps_a_mount_added_while_unmounting(monkeypatch):
    _fake_mount(monkeypatch)
    with _ws() as ws:
        ws.add_fuse_mount("/a/", "/tmp/mp-a")
        monkeypatch.setattr(sys, "platform", "linux")
        unmount = Mock(
            side_effect=lambda _mountpoint: ws.add_fuse_mount(
                "/a/", "/tmp/mp-a2"
            )
        )
        monkeypatch.setattr(
            "mirage.workspace.fuse.unmount_with_fusermount", unmount
        )
        ws.remove_fuse_mount("/a/")
        unmount.side_effect = None
        assert ws.fuse_mountpoints == {"/a/": "/tmp/mp-a2"}
