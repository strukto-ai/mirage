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

from mirage.accessor.base import Accessor
from mirage.vfs.mem0 import Mem0VFS
from mirage.workspace.mount import MountEntry
from tests.fixtures.vfs_io import DOOR_OPS, vfs_over


def test_the_door_serves_reads_only():
    mount = MountEntry("/", vfs_over(Mem0VFS, Accessor()))
    served = {op for op in DOOR_OPS if mount.answers(op)}
    assert served == {"glob", "read", "readdir", "stat"}
