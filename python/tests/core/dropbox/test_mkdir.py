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

from mirage.core.dropbox.mkdir import mkdir
from mirage.types import PathSpec

CREATE_ROUTE = "/2/files/create_folder_v2"


@pytest.mark.asyncio
async def test_mkdir_creates_when_parent_exists(account):
    await mkdir(account.accessor(), PathSpec.from_str_path("/docs"))
    assert await account.names() == ["docs"]


@pytest.mark.asyncio
async def test_mkdir_reads_a_conflict_on_the_create_as_eexist(account):
    # The create is sent and Dropbox's conflict is the answer: the only
    # lookup is the path spelling check every op makes.
    await account.mkdir("/docs")
    await account.run.record_requests()
    with pytest.raises(FileExistsError):
        await mkdir(account.accessor(), PathSpec.from_str_path("/docs"))
    sent = await account.run.bodies("POST", CREATE_ROUTE)
    assert [body["path"] for body in sent] == ["/docs"]


@pytest.mark.asyncio
async def test_mkdir_parents_is_idempotent_for_existing_dir(account):
    await account.mkdir("/docs")
    await account.run.record_requests()
    await mkdir(account.accessor(), PathSpec.from_str_path("/docs"), parents=True)
    assert await account.run.bodies("POST", CREATE_ROUTE) == []


@pytest.mark.asyncio
async def test_mkdir_missing_parent_raises_enoent(account):
    await account.run.record_requests()
    with pytest.raises(FileNotFoundError):
        await mkdir(account.accessor(), PathSpec.from_str_path("/a/b"))
    assert await account.run.bodies("POST", CREATE_ROUTE) == []
