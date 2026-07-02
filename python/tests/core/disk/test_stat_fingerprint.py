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

import asyncio

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.stat import stat
from mirage.types import PathSpec


def test_disk_stat_returns_fingerprint_from_mtime(tmp_path):
    p = tmp_path / "f.txt"
    p.write_bytes(b"hi")
    accessor = DiskAccessor(root=tmp_path)
    scope = PathSpec(resource_path="f.txt", virtual="/f.txt", directory="/")
    result = asyncio.run(stat(accessor, scope))
    assert result.fingerprint is not None
    assert result.fingerprint == result.modified
