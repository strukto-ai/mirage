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

import pytest

from mirage.fuse.backend import MountBackend
from mirage.fuse.fs import MirageFS
from mirage.fuse.mount import _await_ready, _prepare_mountpoint, _run_fuse
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


class _CaptureFuse:

    kwargs: dict = {}
    args: tuple = ()

    def __init__(self, *args, **kwargs):
        _CaptureFuse.args = args
        _CaptureFuse.kwargs = kwargs


class _AliveThread:

    def is_alive(self) -> bool:
        return True


@pytest.fixture
def fs():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    return MirageFS(ws.ops)


def test_run_fuse_mount_options(monkeypatch, fs):
    monkeypatch.setattr("mirage.fuse.mount.fuse.FUSE", _CaptureFuse)
    _run_fuse(fs, "/tmp/mp", foreground=True)
    assert _CaptureFuse.args == (fs, "/tmp/mp")
    assert _CaptureFuse.kwargs["nothreads"] is True
    assert _CaptureFuse.kwargs["foreground"] is True
    # direct_io keeps reads correct for tools that never fstat; attr_timeout=0
    # keeps fstat-based tools (wc -c, BSD cp, tail -c) from clamping at the
    # stale pre-open size.
    assert _CaptureFuse.kwargs["direct_io"] is True
    assert _CaptureFuse.kwargs["attr_timeout"] == 0


def test_prepare_mountpoint_win32_removes_empty_dir(monkeypatch, tmp_path):
    mp = tmp_path / "mnt"
    mp.mkdir()
    monkeypatch.setattr("sys.platform", "win32")
    _prepare_mountpoint(str(mp))
    assert not mp.exists()


def test_prepare_mountpoint_win32_refuses_non_empty_dir(monkeypatch, tmp_path):
    mp = tmp_path / "mnt"
    mp.mkdir()
    (mp / "keep.txt").write_text("data")
    monkeypatch.setattr("sys.platform", "win32")
    with pytest.raises(OSError):
        _prepare_mountpoint(str(mp))
    assert (mp / "keep.txt").exists()


def test_prepare_mountpoint_posix_keeps_dir(monkeypatch, tmp_path):
    mp = tmp_path / "mnt"
    mp.mkdir()
    monkeypatch.setattr("sys.platform", "linux")
    _prepare_mountpoint(str(mp))
    assert mp.is_dir()


def test_run_fuse_win32_adds_winfsp_owner_mapping(monkeypatch, fs):
    monkeypatch.setattr("mirage.fuse.mount.fuse.FUSE", _CaptureFuse)
    monkeypatch.setattr("sys.platform", "win32")
    _run_fuse(fs, "/tmp/mp", foreground=True)
    # WinFsp builtin: uid=-1/gid=-1 presents files as owned by the
    # mounting user (POSIX ids have no meaningful SID mapping).
    assert _CaptureFuse.kwargs["uid"] == -1
    assert _CaptureFuse.kwargs["gid"] == -1


def test_run_fuse_posix_omits_owner_mapping(monkeypatch, fs):
    monkeypatch.setattr("mirage.fuse.mount.fuse.FUSE", _CaptureFuse)
    monkeypatch.setattr("sys.platform", "linux")
    _run_fuse(fs, "/tmp/mp", foreground=True)
    assert "uid" not in _CaptureFuse.kwargs
    assert "gid" not in _CaptureFuse.kwargs


def test_fskit_mount_options_match_the_verified_recipe(monkeypatch, fs):
    # Issue #82's only reported working mount was backend=fskit + volname
    # with direct_io omitted. Pin all three: nothing in CI can exercise this
    # path (it needs macOS 15.4+, macFUSE 5.x, and a GUI-enabled FSKit
    # module), so a regression here would ship silently.
    monkeypatch.setattr("mirage.fuse.mount.fuse.FUSE", _CaptureFuse)
    _run_fuse(fs, "/Volumes/mirage-abc", False, MountBackend.FSKIT)
    assert _CaptureFuse.kwargs["backend"] == "fskit"
    assert _CaptureFuse.kwargs["volname"] == "mirage-abc"
    assert "direct_io" not in _CaptureFuse.kwargs
    assert _CaptureFuse.kwargs["attr_timeout"] == 0


def test_an_existing_empty_dir_is_not_a_live_mount(tmp_path):
    # macFUSE creates the /Volumes entry while mounting and leaves the empty
    # directory behind when the FSKit handoff fails. Treating bare existence
    # as ready reported a mount that never came up as live, and the failure
    # surfaced as a confusing ENOENT on the first read instead.
    mp = tmp_path / "mirage-vol"
    mp.mkdir()
    with pytest.raises(TimeoutError):
        _await_ready(_AliveThread(), str(mp), timeout=0.05)


def test_fuse_backend_keeps_direct_io(monkeypatch, fs):
    # The kext path still needs direct_io: without it cat reads 0 bytes from
    # a size-unknown file on macOS (see the CLAUDE.md FUSE section).
    monkeypatch.setattr("mirage.fuse.mount.fuse.FUSE", _CaptureFuse)
    _run_fuse(fs, "/tmp/mirage-abc", False, MountBackend.FUSE)
    assert _CaptureFuse.kwargs["direct_io"] is True
    assert "backend" not in _CaptureFuse.kwargs
    assert "volname" not in _CaptureFuse.kwargs
