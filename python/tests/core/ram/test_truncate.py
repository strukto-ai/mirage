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

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.truncate import truncate
from mirage.observe.context import RecordingScope
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_truncate_to_zero_empties_the_file():
    s = RAMStore()
    a = RAMAccessor(s)
    s.files["/t.txt"] = b"previous"
    await truncate(a, PathSpec.from_str_path("/t.txt"), 0)
    assert s.files["/t.txt"] == b""


@pytest.mark.asyncio
async def test_truncate_extends_with_nul_bytes():
    s = RAMStore()
    a = RAMAccessor(s)
    s.files["/t.txt"] = b"ab"
    await truncate(a, PathSpec.from_str_path("/t.txt"), 4)
    assert s.files["/t.txt"] == b"ab\x00\x00"


@pytest.mark.asyncio
async def test_truncate_records_its_own_op():
    # The op used to leave no record at all, so a guest's 'w' open on
    # an existing file was invisible to the ledger while the same open
    # on a missing file was not.
    s = RAMStore()
    a = RAMAccessor(s)
    s.files["/t.txt"] = b"previous"
    scope = RecordingScope()
    await truncate(a, PathSpec.from_str_path("/t.txt"), 0)
    scope.close()
    assert [r.op for r in scope.records] == ["truncate"]
    assert scope.records[0].bytes == 0
    assert scope.records[0].source == "ram"
