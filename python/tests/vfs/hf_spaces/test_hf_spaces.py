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

from mirage.commands.builtin.backends import mount_commands
from mirage.types import VFSName
from mirage.vfs.hf_spaces import HfSpacesConfig, HfSpacesVFS
from tests.fixtures.vfs_io import served


def test_vfs_name():
    r = HfSpacesVFS(HfSpacesConfig(repo_id="org/space"))
    assert r.name == VFSName.HF_SPACES
    assert r.caches_reads is True


def test_vfs_registers_ops_and_commands():
    r = HfSpacesVFS(HfSpacesConfig(repo_id="org/space"))
    op_names = served(r)
    cmd_names = {c.name for c in mount_commands(r)}
    assert {"read", "readdir", "stat"} <= op_names
    assert {"cat", "ls", "stat"} <= cmd_names
