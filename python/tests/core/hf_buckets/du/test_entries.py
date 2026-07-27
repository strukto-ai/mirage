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

from mirage.core.hf_buckets.du import entries
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_entries_returns_per_file_with_total(make_acc):
    acc = make_acc({
        "data/a.json": b"12345",
        "data/b.json": b"67",
    })
    found, total = await entries(acc, PathSpec.from_str_path("/data"))
    assert total == 7
    assert found == [("/data/a.json", 5), ("/data/b.json", 2)]


@pytest.mark.asyncio
async def test_entries_of_file_is_empty(make_acc):
    acc = make_acc({"data/a.json": b"12345"})
    assert await entries(acc,
                         PathSpec.from_str_path("/data/a.json")) == ([], 5)
