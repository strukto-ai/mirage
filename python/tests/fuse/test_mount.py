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

from mirage.fuse.fs import MirageFS
from mirage.fuse.mount import _prepare_mountpoint, _run_fuse
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


class _CaptureFuse:

    kwargs: dict = {}
    args: tuple = ()

    def __init__(self, *args, **kwargs):
        _CaptureFuse.args = args
        _CaptureFuse.kwargs = kwargs


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
