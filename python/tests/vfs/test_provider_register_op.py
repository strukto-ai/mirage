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
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS


def test_vfs_register_op():

    @op("read", vfs="test", filetype=".custom")
    async def read_custom(store, path):
        return b"custom"

    vfs = BaseVFS()
    vfs.register_op(read_custom)
    ops = vfs.ops_list()
    assert len(ops) == 1
    assert isinstance(ops[0], RegisteredOp)
    assert ops[0].name == "read"
    assert ops[0].filetype == ".custom"


def test_vfs_register_op_empty():
    vfs = BaseVFS()
    assert vfs.ops_list() == []


def test_ram_vfs_registers_ops():
    vfs = RAMVFS()
    ops = vfs.ops_list()
    assert len(ops) > 0
    names = {ro.name for ro in ops}
    assert "read" in names
    assert "write" in names
    assert "stat" in names
