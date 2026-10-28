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

import pytest

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.capacity import count, size_of
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_size_of_counts_a_file_a_subtree_and_nothing(tmp_path):
    (tmp_path / "d" / "e").mkdir(parents=True)
    (tmp_path / "a").write_bytes(b"123")
    (tmp_path / "d" / "b").write_bytes(b"4567")
    (tmp_path / "d" / "e" / "c").write_bytes(b"89")
    os.symlink(tmp_path / "a", tmp_path / "d" / "link")
    accessor = DiskAccessor(tmp_path)
    assert await size_of(accessor, PathSpec.from_str_path("/a")) == 3
    assert await size_of(accessor, PathSpec.from_str_path("/d")) == 6
    assert await size_of(accessor, PathSpec.from_str_path("/none")) == 0
    assert await count(accessor) == 9
