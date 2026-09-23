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

from mirage.types import MountMode
from mirage.vfs.ssh import SSHVFS, SSHConfig
from mirage.workspace.mount.registry import MountRegistry


def test_ssh_mount_registration():
    registry = MountRegistry()
    cfg = SSHConfig(host="dev", root="/home/ubuntu")
    vfs = SSHVFS(cfg)
    registry.mount("/ssh/", vfs, mode=MountMode.WRITE)
    mount = registry.mount_for("/ssh/some/file.txt")
    assert mount is not None
    assert mount.vfs.name == "ssh"


def test_ssh_mount_command_resolution():
    registry = MountRegistry()
    cfg = SSHConfig(host="dev")
    vfs = SSHVFS(cfg)
    registry.mount("/remote/", vfs, mode=MountMode.WRITE)
    mount = registry.mount_for("/remote/test.py")
    assert mount is not None
    cmd = mount.resolve_command("cat", None)
    assert cmd is not None
    assert cmd.vfs == "ssh"
