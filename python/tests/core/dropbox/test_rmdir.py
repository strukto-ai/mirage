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

import errno

import pytest

from mirage.core.dropbox.rmdir import rmdir
from mirage.types import PathSpec

LIST_ROUTE = "/2/files/list_folder"
CONTINUE_ROUTE = "/2/files/list_folder/continue"
DELETE_ROUTE = "/2/files/delete_v2"


@pytest.mark.asyncio
async def test_rmdir_nonempty_raises_enotempty_without_deleting(account):
    await account.put("/docs/a.txt", b"a")
    with pytest.raises(OSError) as excinfo:
        await rmdir(account.accessor(), PathSpec.from_str_path("/docs"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert await account.names("/docs") == ["a.txt"]


@pytest.mark.asyncio
async def test_rmdir_removes_empty_folder(account):
    await account.mkdir("/docs")
    await rmdir(account.accessor(), PathSpec.from_str_path("/docs"))
    assert await account.names() == []


@pytest.mark.asyncio
async def test_rmdir_file_raises_enotdir(account):
    await account.put("/a.txt", b"a")
    with pytest.raises(NotADirectoryError):
        await rmdir(account.accessor(), PathSpec.from_str_path("/a.txt"))


@pytest.mark.asyncio
async def test_rmdir_probe_is_bounded_to_one_entry(account):
    # The emptiness probe is bounded, not a full listing: `list_folder`
    # follows every continuation cursor, so asking it with a small page
    # size made one request per child to answer a yes/no.
    for name in ("a", "b", "c"):
        await account.put(f"/docs/{name}", b"x")
    await account.run.record_requests()
    with pytest.raises(OSError) as excinfo:
        await rmdir(account.accessor(), PathSpec.from_str_path("/docs"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    listed = await account.run.bodies("POST", LIST_ROUTE)
    assert [body.get("limit") for body in listed] == [1]
    assert await account.run.bodies("POST", CONTINUE_ROUTE) == []
    assert await account.run.bodies("POST", DELETE_ROUTE) == []
