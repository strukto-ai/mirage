# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import subprocess

import pytest

from mirage import FuseManager, Mount, MountMode, Workspace
from mirage.resource.ram import RAMResource


class _FakeThread:

    def __init__(self):
        self.alive = True


def _fake_mount(monkeypatch):
    monkeypatch.setattr("mirage.workspace.fuse.mount_background",
                        lambda ops, mountpoint, root_prefix="": _FakeThread())
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)


def test_add_fuse_mount_registers_and_returns_mountpoint(monkeypatch):
    _fake_mount(monkeypatch)
    ws = Workspace({"/a/": RAMResource()}, mode=MountMode.WRITE)
    mp = ws.add_fuse_mount("/a/", "/tmp/forced-a")
    assert mp == "/tmp/forced-a"
    assert ws.fuse_mountpoints == {"/a/": "/tmp/forced-a"}
    ws.remove_fuse_mount("/a/")
    assert ws.fuse_mountpoints == {}


def test_workspace_close_unmounts_managers(monkeypatch):
    _fake_mount(monkeypatch)
    with Workspace({"/a/": RAMResource()}, mode=MountMode.WRITE) as ws:
        ws.add_fuse_mount("/a/", "/tmp/tracked-a")
        assert ws.fuse_mountpoints == {"/a/": "/tmp/tracked-a"}
    assert ws.fuse_mountpoints == {}


def test_multiple_fuse_mounts_are_independent(monkeypatch):
    _fake_mount(monkeypatch)
    ws = Workspace({
        "/a/": RAMResource(),
        "/b/": RAMResource()
    },
                   mode=MountMode.WRITE)
    ws.add_fuse_mount("/a/", "/tmp/mp-a")
    ws.add_fuse_mount("/b/", "/tmp/mp-b")
    assert ws.fuse_mountpoints == {"/a/": "/tmp/mp-a", "/b/": "/tmp/mp-b"}
    assert set(ws._fuse_managers) == {"/a/", "/b/"}
    ws.remove_fuse_mount("/a/")
    assert ws.fuse_mountpoints == {"/b/": "/tmp/mp-b"}
    assert set(ws._fuse_managers) == {"/b/"}


def test_collision_rejected_before_mount(monkeypatch):
    calls = []
    monkeypatch.setattr("mirage.workspace.fuse.mount_background",
                        lambda ops, mountpoint, root_prefix="":
                        (calls.append(mountpoint) or _FakeThread()))
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)
    ws = Workspace({
        "/a/": RAMResource(),
        "/b/": RAMResource()
    },
                   mode=MountMode.WRITE)
    ws.add_fuse_mount("/a/", "/tmp/dup-mp")
    with pytest.raises(ValueError):
        ws.add_fuse_mount("/b/", "/tmp/dup-mp")
    assert ws.fuse_mountpoints == {"/a/": "/tmp/dup-mp"}
    assert calls == ["/tmp/dup-mp"]


def test_double_unmount_is_idempotent(monkeypatch):
    _fake_mount(monkeypatch)
    ws = Workspace({"/a/": RAMResource()}, mode=MountMode.WRITE)
    fm = FuseManager()
    fm.setup(ws._ops, "/a/", mountpoint="/tmp/idem-a")
    fm.unmount()
    fm.unmount()  # must not raise
    assert fm.mountpoint is None


def test_mount_spec_fuse_true_single(monkeypatch):
    _fake_mount(monkeypatch)
    ws = Workspace({"/gdocs/": Mount(RAMResource(), fuse=True)},
                   mode=MountMode.WRITE)
    mps = ws.fuse_mountpoints
    assert set(mps) == {"/gdocs/"}
    assert mps["/gdocs/"]
    assert ws.fuse_mountpoint == mps["/gdocs/"]


def test_mount_spec_fuse_pinned_path(monkeypatch):
    _fake_mount(monkeypatch)
    ws = Workspace({"/whatever/": Mount(RAMResource(), fuse="/tmp/pinned-x")},
                   mode=MountMode.WRITE)
    assert ws.fuse_mountpoints["/whatever/"] == "/tmp/pinned-x"


def test_mount_spec_fuse_each_of_multiple(monkeypatch):
    _fake_mount(monkeypatch)
    ws = Workspace(
        {
            "/a/": Mount(RAMResource(), fuse=True),
            "/b/": Mount(RAMResource(), fuse=True)
        },
        mode=MountMode.WRITE)
    assert set(ws.fuse_mountpoints) == {"/a/", "/b/"}
    with pytest.raises(RuntimeError):
        ws.fuse_mountpoint


def test_mount_spec_mode_inherits_and_override(monkeypatch):
    _fake_mount(monkeypatch)
    ws = Workspace(
        {
            "/inherit/": Mount(RAMResource()),
            "/override/": Mount(RAMResource(), mode=MountMode.READ),
        },
        mode=MountMode.WRITE)
    assert ws.mount("/inherit/").mode == MountMode.WRITE
    assert ws.mount("/override/").mode == MountMode.READ


def test_no_fuse_when_bare_or_tuple(monkeypatch):
    _fake_mount(monkeypatch)
    ws = Workspace(
        {
            "/bare/": RAMResource(),
            "/tup/": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE)
    assert ws.fuse_mountpoints == {}


def test_mount_spec_fuse_unmounts_on_close(monkeypatch):
    _fake_mount(monkeypatch)
    with Workspace({"/gdocs/": Mount(RAMResource(), fuse=True)},
                   mode=MountMode.WRITE) as ws:
        assert set(ws.fuse_mountpoints) == {"/gdocs/"}
    assert ws.fuse_mountpoints == {}
