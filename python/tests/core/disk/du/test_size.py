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

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.du import size
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_size_single_file(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"hello")
    accessor = DiskAccessor(tmp_path)
    result = await size(
        accessor,
        PathSpec(resource_path="a.txt", virtual="/a.txt", directory="/a.txt"))
    assert result == 5


@pytest.mark.asyncio
async def test_size_directory(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"aaa")
    (tmp_path / "b.txt").write_bytes(b"bb")
    accessor = DiskAccessor(tmp_path)
    result = await size(accessor,
                        PathSpec(resource_path="", virtual="/", directory="/"))
    assert result == 5
