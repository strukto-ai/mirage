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

from mirage.ops.registry import RegisteredOp, op
from mirage.types import MountMode
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace.mount import MountRegistry


def test_base_vfs_serves_no_ops():
    vfs = BaseVFS()
    assert vfs.ops() == []


def test_ram_vfs_serves_ops():
    vfs = RAMVFS()
    ops = vfs.ops()
    assert len(ops) > 0
    assert all(isinstance(ro, RegisteredOp) for ro in ops)
    names = {ro.name for ro in ops}
    assert "read" in names
    assert "write" in names
    assert "stat" in names


def test_mount_registers_the_driver_tables():

    @op("read", vfs="probe")
    async def read_custom(store, path, **kwargs):
        return b"custom"

    class ProbeVFS(BaseVFS):
        name = "probe"

        def ops(self) -> list[RegisteredOp]:
            return list(read_custom._registered_ops)

    registry = MountRegistry()
    mount = registry.mount("/p/", ProbeVFS(), MountMode.READ)
    assert mount.has_op("read")
    assert not mount.has_op("write")
    assert registry.mount("/r/", RAMVFS(), MountMode.READ).has_op("write")
