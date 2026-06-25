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
import tempfile

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace.fuse import FuseManager
from mirage.workspace.workspace import Workspace


def _fake_mount(monkeypatch):
    monkeypatch.setattr("mirage.workspace.fuse.mount_background",
                        lambda *_args, **_kwargs: None)
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)


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

        ws = Workspace({"/a/": RAMResource()}, mode=MountMode.WRITE)
        fm = FuseManager()
        fm.setup(ws._ops, prefix="/a/", mountpoint=str(tmp_path))
        fm.close()

        assert tmp_path.exists()
        assert fm.mountpoint is None

    def test_close_removes_generated_mountpoint(self, monkeypatch, tmp_path):
        # Generated temp mountpoints are Mirage-owned, so close() removes the
        # directory it created with an empty-directory rmdir.
        generated = tmp_path / "mirage-generated"
        generated.mkdir()
        _fake_mount(monkeypatch)
        monkeypatch.setattr(tempfile, "mkdtemp",
                            lambda *_args, **_kwargs: str(generated))

        ws = Workspace({"/a/": RAMResource()}, mode=MountMode.WRITE)
        fm = FuseManager()
        fm.setup(ws._ops, prefix="/a/")
        fm.close()

        assert not generated.exists()
        assert fm.mountpoint is None
