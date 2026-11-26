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

from mirage.core.dropbox.rm import rm_r
from mirage.types import PathSpec

DELETE_ROUTE = "/2/files/delete_v2"


@pytest.mark.asyncio
async def test_rm_r_deletes_recursively_in_one_call(account):
    await account.put("/Team/docs/sub/a.txt", b"a")
    await account.run.record_requests()
    await rm_r(account.accessor("/Team"), PathSpec.from_str_path("/docs"))
    assert await account.run.bodies("POST", DELETE_ROUTE) == [
        {"path": "/Team/docs"}
    ]
    assert await account.names("/Team") == []


@pytest.mark.asyncio
async def test_rm_r_missing_raises_enoent(account):
    with pytest.raises(FileNotFoundError):
        await rm_r(account.accessor(), PathSpec.from_str_path("/ghost"))
