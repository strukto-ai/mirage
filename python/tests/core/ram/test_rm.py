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

from mirage.core.ram.rm import rm_r
from tests.fixtures.ram_capacity import capped, ram_path, table_bytes


@pytest.mark.asyncio
async def test_rm_r_removes_the_subtree_and_keeps_the_rest():
    accessor, _ = capped(100, {"/d/a": b"1", "/d/e/b": b"2", "/da": b"3"})
    accessor.store.dirs.update({"/d", "/d/e"})
    await rm_r(accessor, ram_path("/d"))
    assert accessor.store.files == {"/da": b"3"}
    assert accessor.store.dirs == {"/"}


@pytest.mark.asyncio
async def test_a_capped_rm_r_takes_back_every_removed_files_bytes():
    accessor, usage = capped(
        5, {"/d/a": b"12345", "/d/e/b": b"123", "/x": b"1"}
    )
    accessor.store.dirs.update({"/d", "/d/e"})
    await rm_r(accessor, ram_path("/d"))
    assert usage.used == table_bytes(accessor) == 1
