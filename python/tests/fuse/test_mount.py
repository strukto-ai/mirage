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
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from mirage.fuse.backend import MountBackend
from mirage.fuse.fs import MirageFS
from mirage.fuse.mount import (_await_ready, _prepare_mountpoint, _run_fuse,
                               load_fuse)
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


_FUSE = SimpleNamespace(FUSE=_CaptureFuse)


@pytest.fixture
def fs():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    return MirageFS(ws.fs)


def test_run_fuse_mount_options(fs):
    _run_fuse(_FUSE, fs, "/tmp/mp", foreground=True)
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
    monkeypatch.setattr("sys.platform", "win32")
    _run_fuse(_FUSE, fs, "/tmp/mp", foreground=True)
    # WinFsp builtin: uid=-1/gid=-1 presents files as owned by the
    # mounting user (POSIX ids have no meaningful SID mapping).
    assert _CaptureFuse.kwargs["uid"] == -1
    assert _CaptureFuse.kwargs["gid"] == -1


def test_run_fuse_posix_omits_owner_mapping(monkeypatch, fs):
    monkeypatch.setattr("sys.platform", "linux")
    _run_fuse(_FUSE, fs, "/tmp/mp", foreground=True)
    assert "uid" not in _CaptureFuse.kwargs
    assert "gid" not in _CaptureFuse.kwargs


def test_fskit_mount_options_match_the_verified_recipe(fs):
    # Issue #82's only reported working mount was backend=fskit + volname
    # with direct_io omitted. Pin all three: nothing in CI can exercise this
    # path (it needs macOS 15.4+, macFUSE 5.x, and a GUI-enabled FSKit
    # module), so a regression here would ship silently.
    _run_fuse(_FUSE, fs, "/Volumes/mirage-abc", False, MountBackend.FSKIT)
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


def test_fuse_backend_keeps_direct_io(fs):
    # The kext path still needs direct_io: without it cat reads 0 bytes from
    # a size-unknown file on macOS (see the CLAUDE.md FUSE section).
    _run_fuse(_FUSE, fs, "/tmp/mirage-abc", False, MountBackend.FUSE)
    assert _CaptureFuse.kwargs["direct_io"] is True
    assert "backend" not in _CaptureFuse.kwargs
    assert "volname" not in _CaptureFuse.kwargs


_NO_LIBFUSE_PROBE = """
import sys


class _Blocker:

    def find_spec(self, name, path=None, target=None):
        if name == "mfusepy":
            raise OSError("Unable to find libfuse")
        return None


sys.meta_path.insert(0, _Blocker())

import mirage  # noqa: F401

assert "mfusepy" not in sys.modules
"""


def test_import_does_not_load_mfusepy():
    proc = subprocess.run([sys.executable, "-c", _NO_LIBFUSE_PROBE],
                          capture_output=True,
                          text=True)
    assert proc.returncode == 0, proc.stderr


@pytest.mark.parametrize("err", [
    ImportError("No module named 'mfusepy'"),
    OSError("Unable to find libfuse"),
    AttributeError("Found library libfuse.so.3 has wrong major version: 3"),
])
def test_load_fuse_reports_missing_driver(monkeypatch, err):
    # Every way mfusepy can fail to resolve libfuse means the same thing to
    # a caller, so all of them have to arrive as the actionable RuntimeError
    # naming the extra and the drivers.
    importer = Mock(side_effect=err)
    monkeypatch.setattr("mirage.fuse.mount.importlib.import_module", importer)
    with pytest.raises(RuntimeError, match="OS driver") as exc:
        load_fuse()
    assert exc.value.__cause__ is err


def test_load_fuse_installs_macfuse_extensions(monkeypatch):
    # The FSKit write surface rides on the Darwin-only callbacks being
    # declared before the operations struct is built (CLAUDE.md, FUSE), and
    # the loader is the only place left that declares them.
    module = SimpleNamespace()
    install = Mock()
    monkeypatch.setattr("mirage.fuse.mount.importlib.import_module",
                        Mock(return_value=module))
    monkeypatch.setattr("mirage.fuse.mount.install_macfuse_extensions",
                        install)
    assert load_fuse() is module
    install.assert_called_once_with(module)
