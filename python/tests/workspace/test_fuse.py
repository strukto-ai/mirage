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

import os
import subprocess
import sys
import tempfile
from unittest.mock import Mock

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace.fuse import FuseManager
from mirage.workspace.workspace import Workspace


def _fake_mount(monkeypatch):
    monkeypatch.setattr(
        "mirage.workspace.fuse.mount_background",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "mirage.workspace.fuse.unmount_with_fusermount",
        lambda _mountpoint: None,
    )


class TestFuseManager:
    def test_initial_state(self):
        fm = FuseManager()
        assert fm.mountpoint is None

    def test_close_without_mountpoint_does_nothing(self):
        fm = FuseManager()
        fm.close()
        assert fm.mountpoint is None

    def test_close_keeps_caller_owned_mountpoint(self, monkeypatch, tmp_path):
        # Regression: explicit mountpoints are caller-owned deployment paths.
        # close() should unmount FUSE, not remove the directory given by the
        # caller.
        _fake_mount(monkeypatch)

        ws = Workspace({"/a/": RAMVFS()}, mode=MountMode.WRITE)
        fm = FuseManager()
        fm.setup(ws._files, prefix="/a/", mountpoint=str(tmp_path))
        fm.close()

        assert tmp_path.exists()
        assert fm.mountpoint is None

    def test_close_removes_generated_mountpoint(self, monkeypatch, tmp_path):
        # Generated temp mountpoints are Mirage-owned, so close() removes the
        # directory it created with an empty-directory rmdir.
        generated = tmp_path / "mirage-generated"
        generated.mkdir()
        _fake_mount(monkeypatch)
        monkeypatch.setattr(
            tempfile, "mkdtemp", lambda *_args, **_kwargs: str(generated)
        )

        ws = Workspace({"/a/": RAMVFS()}, mode=MountMode.WRITE)
        fm = FuseManager()
        fm.setup(ws._files, prefix="/a/")
        fm.close()

        assert not generated.exists()
        assert fm.mountpoint is None

    def test_unmount_failure_keeps_mountpoint(self, monkeypatch, tmp_path):
        _fake_mount(monkeypatch)
        ws = Workspace({"/a/": RAMVFS()}, mode=MountMode.WRITE)
        fm = FuseManager()
        fm.setup(ws._files, prefix="/a/", mountpoint=str(tmp_path))
        monkeypatch.setattr(sys, "platform", "linux")
        monkeypatch.setattr(
            "mirage.workspace.fuse.unmount_with_fusermount",
            Mock(side_effect=FileNotFoundError("cannot unmount")),
        )

        with pytest.raises(FileNotFoundError, match="cannot unmount"):
            fm.unmount()
        assert fm.mountpoint == str(tmp_path)

    def test_mounts_and_unmounts_the_path_resolved_at_mount(
        self, monkeypatch, tmp_path
    ):
        real = tmp_path / "real"
        real.mkdir()
        link = tmp_path / "link"
        link.symlink_to(real)
        _fake_mount(monkeypatch)
        mounted = Mock()
        monkeypatch.setattr("mirage.workspace.fuse.mount_background", mounted)
        monkeypatch.setattr(sys, "platform", "linux")
        ws = Workspace({"/a/": RAMVFS()}, mode=MountMode.WRITE)
        fm = FuseManager()
        fm.setup(ws._files, prefix="/a/", mountpoint=str(link / "mp"))
        link.unlink()
        unmount = Mock()
        monkeypatch.setattr(
            "mirage.workspace.fuse.unmount_with_fusermount", unmount
        )

        fm.unmount()

        resolved = os.path.join(os.path.realpath(real), "mp")
        assert mounted.call_args.args[1] == resolved
        unmount.assert_called_once_with(resolved)
