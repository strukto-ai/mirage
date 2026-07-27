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
from mirage.core.ram.du import entries
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.fixture
def store():
    s = RAMStore()
    s.dirs.add("/sub")
    s.files["/a.txt"] = b"hello"
    s.files["/sub/b.txt"] = b"world!"
    s.files["/sub/c.txt"] = b"data"
    return RAMAccessor(s)


@pytest.mark.asyncio
async def test_entries_root(store):
    found, total = await entries(
        store, PathSpec(resource_path="", virtual="/", directory="/"))
    assert total == 15
    paths = [e[0] for e in found]
    assert "/a.txt" in paths
    assert "/sub/b.txt" in paths
    assert "/sub/c.txt" in paths


@pytest.mark.asyncio
async def test_entries_subdir(store):
    found, total = await entries(
        store, PathSpec(resource_path="sub", virtual="/sub", directory="/sub"))
    assert total == 10
    assert len(found) == 2
