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
from mirage.core.ram.create import create
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_create():
    s = RAMStore()

    a = RAMAccessor(s)
    await create(a, PathSpec.from_str_path("/new.txt"))
    assert s.files["/new.txt"] == b""
    assert "/new.txt" in s.modified


@pytest.mark.asyncio
async def test_create_overwrites_existing():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/existing.txt"] = b"old data"
    await create(a, PathSpec.from_str_path("/existing.txt"))
    assert s.files["/existing.txt"] == b""


@pytest.mark.asyncio
async def test_create_normalizes_path():
    s = RAMStore()

    a = RAMAccessor(s)
    await create(a, PathSpec.from_str_path("file.txt"))
    assert "/file.txt" in s.files
