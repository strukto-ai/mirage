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

from mirage.core.dropbox.unlink import unlink
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_unlink_deletes_file(account):
    await account.put("/a.txt", b"a")
    await unlink(account.accessor(), PathSpec.from_str_path("/a.txt"))
    assert await account.names() == []


@pytest.mark.asyncio
async def test_unlink_folder_raises_eisdir(account):
    await account.mkdir("/docs")
    with pytest.raises(IsADirectoryError):
        await unlink(account.accessor(), PathSpec.from_str_path("/docs"))
    assert await account.names() == ["docs"]


@pytest.mark.asyncio
async def test_unlink_missing_raises_enoent(account):
    with pytest.raises(FileNotFoundError):
        await unlink(account.accessor(), PathSpec.from_str_path("/ghost"))
