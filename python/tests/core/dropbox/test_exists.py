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

from mirage.core.dropbox.exists import exists
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_mount_root_exists_without_api_call(account):
    await account.run.record_requests()
    assert await exists(account.accessor(), PathSpec.from_str_path("/"))
    assert await account.run.requests() == []


@pytest.mark.asyncio
async def test_409_maps_to_false(account):
    assert not await exists(
        account.accessor(), PathSpec.from_str_path("/ghost")
    )


@pytest.mark.asyncio
async def test_found_maps_to_true(account):
    await account.put("/a.txt", b"a")
    assert await exists(account.accessor(), PathSpec.from_str_path("/a.txt"))
