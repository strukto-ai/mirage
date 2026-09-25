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

from mirage.core.hf_buckets.exists import exists
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_exists_true_for_file(make_acc):
    acc = make_acc({"a.txt": b"x"})
    assert await exists(acc, PathSpec.from_str_path("/a.txt")) is True


@pytest.mark.asyncio
async def test_exists_false_for_missing(make_acc):
    acc = make_acc({})
    assert await exists(acc, PathSpec.from_str_path("/missing.txt")) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code", [(401, ""), (404, "RepoNotFound")])
async def test_exists_raises_on_a_refused_bucket(make_acc, fake_hub, status,
                                                 code):
    # A bucket the Hub will not show is not a missing file: False here
    # would let a caller conclude it can create the path.
    acc = make_acc({"a.txt": b"x"})
    fake_hub.fail["bucket_paths_info"] = (status, code)
    with pytest.raises(PermissionError):
        await exists(acc, PathSpec.from_str_path("/a.txt"))
