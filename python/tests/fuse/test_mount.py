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

import io
import os
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from mirage.fuse.backend import MountBackend
from mirage.fuse.constants import UTIME_NOW, UTIME_OMIT
from mirage.fuse.fs import MirageFS
from mirage.fuse.mount import (
    _await_ready,
    _marshal_utimens,
    _prepare_mountpoint,
    _run_fuse,
    canonical_mountpoint,
    is_mounted,
    load_fuse,
    resolve_fusermount_binary,
    unmount_with_fusermount,
)
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
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
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    return MirageFS(ws.vfs)


def test_run_fuse_mount_options(fs):
    _run_fuse(_FUSE, fs, "/tmp/mp")
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
    _run_fuse(_FUSE, fs, "/tmp/mp")
    # WinFsp builtin: uid=-1/gid=-1 presents files as owned by the
    # mounting user (POSIX ids have no meaningful SID mapping).
    assert _CaptureFuse.kwargs["uid"] == -1
    assert _CaptureFuse.kwargs["gid"] == -1


def test_run_fuse_posix_omits_owner_mapping(monkeypatch, fs):
    monkeypatch.setattr("sys.platform", "linux")
    _run_fuse(_FUSE, fs, "/tmp/mp")
    assert "uid" not in _CaptureFuse.kwargs
    assert "gid" not in _CaptureFuse.kwargs


def test_fskit_mount_options_match_the_verified_recipe(fs):
    # Issue #82's only reported working mount was backend=fskit + volname
    # with direct_io omitted. Pin all three: nothing in CI can exercise this
    # path (it needs macOS 15.4+, macFUSE 5.x, and a GUI-enabled FSKit
    # module), so a regression here would ship silently.
    _run_fuse(_FUSE, fs, "/Volumes/mirage-abc", MountBackend.FSKIT)
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
    _run_fuse(_FUSE, fs, "/tmp/mirage-abc", MountBackend.FUSE)
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
    proc = subprocess.run(
        [sys.executable, "-c", _NO_LIBFUSE_PROBE],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr


@pytest.mark.parametrize(
    "err",
    [
        ImportError("No module named 'mfusepy'"),
        OSError("Unable to find libfuse"),
        AttributeError(
            "Found library libfuse.so.3 has wrong major version: 3"
        ),
    ],
)
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
    # the loader is the only place left that declares them. It also swaps
    # in the utimens marshalling that keeps utimensat's markers.
    module = SimpleNamespace(FUSE=type("FUSE", (), {}))
    install = Mock()
    monkeypatch.setattr(
        "mirage.fuse.mount.importlib.import_module", Mock(return_value=module)
    )
    monkeypatch.setattr(
        "mirage.fuse.mount.install_macfuse_extensions", install
    )
    assert load_fuse() is module
    install.assert_called_once_with(module)
    assert module.FUSE.utimens_fuse_2 is _marshal_utimens


def test_resolve_fusermount_binary_prefers_legacy(monkeypatch):
    # https://github.com/strukto-ai/mirage/issues/1422
    # fusermount-only systems keep working; fusermount3-only systems
    # (Amazon Linux 2023) get the fallback instead of FileNotFoundError.
    monkeypatch.setattr(
        "mirage.fuse.mount.shutil.which",
        lambda name: {
            "fusermount": "/usr/bin/fusermount",
            "fusermount3": "/usr/bin/fusermount3",
        }.get(name),
    )
    assert resolve_fusermount_binary() == "/usr/bin/fusermount"


def test_resolve_fusermount_binary_falls_back_to_fusermount3(monkeypatch):
    # https://github.com/strukto-ai/mirage/issues/1422
    monkeypatch.setattr(
        "mirage.fuse.mount.shutil.which",
        lambda name: {"fusermount3": "/usr/bin/fusermount3"}.get(name),
    )
    assert resolve_fusermount_binary() == "/usr/bin/fusermount3"


def test_resolve_fusermount_binary_returns_none_when_missing(monkeypatch):
    monkeypatch.setattr("mirage.fuse.mount.shutil.which", lambda name: None)
    assert resolve_fusermount_binary() is None


def test_is_mounted_reads_the_kernel_mount_table(monkeypatch):
    table = (
        b"proc /proc proc rw 0 0\n"
        b"mirage /mnt/my\\040mount fuse.mirage rw 0 0\n"
    )
    monkeypatch.setattr(
        "mirage.fuse.mount.open",
        lambda *_args, **_kwargs: io.BytesIO(table),
        raising=False,
    )
    assert is_mounted("/mnt/my mount")
    assert not is_mounted("/mnt/other")


def test_canonical_mountpoint_resolves_a_symlinked_parent(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "link").symlink_to(real)
    assert canonical_mountpoint(str(tmp_path / "link" / "mp")) == (
        os.path.join(os.path.realpath(real), "mp")
    )


def test_unmount_with_fusermount_raises_while_mounted_without_helper(
    monkeypatch,
):
    monkeypatch.setattr("mirage.fuse.mount.shutil.which", lambda name: None)
    monkeypatch.setattr("mirage.fuse.mount.is_mounted", lambda _path: True)
    with pytest.raises(FileNotFoundError, match="fusermount3"):
        unmount_with_fusermount("/mnt/m")


def test_unmount_with_fusermount_skips_a_mount_already_gone(monkeypatch):
    monkeypatch.setattr("mirage.fuse.mount.shutil.which", lambda name: None)
    monkeypatch.setattr("mirage.fuse.mount.is_mounted", lambda _path: False)
    unmount_with_fusermount("/mnt/m")


def test_unmount_with_fusermount_raises_a_helper_failure_while_mounted(
    monkeypatch,
):
    run = Mock(
        return_value=SimpleNamespace(
            returncode=1, stderr=b"fusermount3: device or resource busy\n"
        )
    )
    monkeypatch.setattr(
        "mirage.fuse.mount.shutil.which",
        lambda name: "/usr/bin/fusermount3" if name == "fusermount3" else None,
    )
    monkeypatch.setattr("mirage.fuse.mount.subprocess.run", run)
    monkeypatch.setattr("mirage.fuse.mount.is_mounted", lambda _path: True)
    with pytest.raises(OSError, match="cannot unmount /mnt/m: .*busy"):
        unmount_with_fusermount("/mnt/m")
    run.assert_called_once_with(
        ["/usr/bin/fusermount3", "-uz", "/mnt/m"], capture_output=True
    )


def test_unmount_with_fusermount_skips_a_helper_failure_once_gone(
    monkeypatch,
):
    monkeypatch.setattr(
        "mirage.fuse.mount.shutil.which", lambda name: "/usr/bin/" + name
    )
    monkeypatch.setattr(
        "mirage.fuse.mount.subprocess.run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=1, stderr=b"not found in /etc/mtab\n"
        ),
    )
    monkeypatch.setattr("mirage.fuse.mount.is_mounted", lambda _path: False)
    unmount_with_fusermount("/mnt/m")


def _utimbuf(
    atime: tuple[int, int], mtime: tuple[int, int]
) -> SimpleNamespace:
    def spec(sec: int, nsec: int) -> SimpleNamespace:
        return SimpleNamespace(tv_sec=sec, tv_nsec=nsec)

    return SimpleNamespace(
        contents=SimpleNamespace(actime=spec(*atime), modtime=spec(*mtime))
    )


def test_utimens_marshalling_reads_the_utimensat_markers():
    # mfusepy folds a timespec into one number, so `touch -m` would store
    # its UTIME_OMIT access time as a date in 1970.
    seen = []
    fuse = SimpleNamespace(
        encoding="utf-8",
        errors="surrogateescape",
        operations=SimpleNamespace(
            utimens=lambda path, times: seen.append((path, times)) or 0
        ),
    )
    _marshal_utimens(fuse, b"/f", _utimbuf((0, UTIME_OMIT), (5, 7)))
    _marshal_utimens(fuse, b"/f", _utimbuf((0, UTIME_NOW), (0, UTIME_OMIT)))
    _marshal_utimens(fuse, b"/f", None)
    assert seen[0] == ("/f", (None, 5_000_000_007))
    assert seen[1][1][0] > 5_000_000_007 and seen[1][1][1] is None
    assert seen[2] == ("/f", None)
