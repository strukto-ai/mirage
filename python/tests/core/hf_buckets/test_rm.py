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

from mirage.core.hf_buckets.rm import rm_r
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_rm_r_deletes_all_keys_under_prefix(make_acc):
    acc = make_acc({
        "data/a.txt": b"a",
        "data/sub/b.txt": b"b",
        "data/sub/deep/c.txt": b"c",
        "other/keep.txt": b"k",
    })
    await rm_r(acc, PathSpec.from_str_path("/data"))
    assert sorted(acc._fake.files) == ["other/keep.txt"]


@pytest.mark.asyncio
async def test_rm_r_on_empty_prefix_is_noop(make_acc):
    acc = make_acc({"other/keep.txt": b"k"})
    await rm_r(acc, PathSpec.from_str_path("/missing"))
    assert sorted(acc._fake.files) == ["other/keep.txt"]
