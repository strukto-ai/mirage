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

from mirage.types import VFSName
from mirage.vfs.ssh import SSHVFS, SSHConfig


def test_ssh_config_frozen():
    cfg = SSHConfig(host="dev", root="/home/ubuntu")
    assert cfg.host == "dev"
    assert cfg.root == "/home/ubuntu"
    with pytest.raises(Exception):
        cfg.host = "other"


def test_ssh_vfs_attributes():
    cfg = SSHConfig(host="dev")
    vfs = SSHVFS(cfg)
    assert vfs.name == VFSName.SSH
    assert vfs.caches_reads is True
    assert len(vfs.commands()) > 0
    assert len(vfs.ops_list()) > 0


def test_ssh_vfs_command_count():
    cfg = SSHConfig(host="dev")
    vfs = SSHVFS(cfg)
    cmd_names = {c.name for c in vfs.commands()}
    assert "cat" in cmd_names
    assert "ls" in cmd_names
    assert "grep" in cmd_names
    assert "find" in cmd_names
    assert "cp" in cmd_names
    assert "rm" in cmd_names


def test_ssh_vfs_ops_count():
    cfg = SSHConfig(host="dev")
    vfs = SSHVFS(cfg)
    op_names = {o.name for o in vfs.ops_list()}
    assert "read" in op_names
    assert "write" in op_names
    assert "stat" in op_names
    assert "readdir" in op_names
    assert "mkdir" in op_names
    assert "unlink" in op_names
