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

from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.rename import rename
from mirage.types import PathSpec

MOVE_ROUTE = "/2/files/move_v2"
DELETE_ROUTE = "/2/files/delete_v2"
LIST_ROUTE = "/2/files/list_folder"
CONTINUE_ROUTE = "/2/files/list_folder/continue"


async def _rename(account, src: str, dst: str) -> None:
    await rename(
        account.accessor(),
        PathSpec.from_str_path(src),
        PathSpec.from_str_path(dst),
    )


async def _deleted(account) -> list[str]:
    return [b["path"] for b in await account.run.bodies("POST", DELETE_ROUTE)]


@pytest.mark.asyncio
async def test_rename_replaces_existing_destination_file(account):
    # Dropbox refuses a move onto a file; mv replaces it, so the file goes
    # and the move is asked again.
    await account.put("/a.txt", b"mine")
    await account.put("/b.txt", b"theirs")
    await account.run.record_requests()
    await _rename(account, "/a.txt", "/b.txt")
    assert await _deleted(account) == ["/b.txt"]
    assert len(await account.run.bodies("POST", MOVE_ROUTE)) == 2
    assert await account.names() == ["b.txt"]
    assert await account.read("/b.txt") == b"mine"


@pytest.mark.asyncio
async def test_rename_conflict_replaces_empty_dir_destination(account):
    await account.put("/src/x.txt", b"x")
    await account.mkdir("/dst")
    await account.run.record_requests()
    await _rename(account, "/src", "/dst")
    assert await _deleted(account) == ["/dst"]
    assert len(await account.run.bodies("POST", MOVE_ROUTE)) == 2
    assert await account.names() == ["dst"]
    assert await account.names("/dst") == ["x.txt"]


@pytest.mark.asyncio
async def test_rename_conflict_keeps_error_for_nonempty_dir(account):
    await account.mkdir("/src")
    await account.put("/dst/keep.txt", b"k")
    await account.run.record_requests()
    with pytest.raises(DropboxApiError):
        await _rename(account, "/src", "/dst")
    assert await _deleted(account) == []
    assert len(await account.run.bodies("POST", MOVE_ROUTE)) == 1
    assert await account.names("/dst") == ["keep.txt"]


@pytest.mark.asyncio
async def test_rename_missing_source_raises_enoent(account):
    with pytest.raises(FileNotFoundError):
        await _rename(account, "/ghost", "/b.txt")


@pytest.mark.asyncio
async def test_rename_conflict_probe_is_bounded_to_one_entry(account):
    # The conflict probe is bounded, not a full listing: `list_folder`
    # follows every continuation cursor, so asking it with a small page
    # size made one request per child to answer a yes/no.
    await account.mkdir("/src")
    for name in ("a", "b", "c"):
        await account.put(f"/dst/{name}", b"k")
    await account.run.record_requests()
    with pytest.raises(DropboxApiError):
        await _rename(account, "/src", "/dst")
    listed = await account.run.bodies("POST", LIST_ROUTE)
    assert [body.get("limit") for body in listed] == [1]
    assert await account.run.bodies("POST", CONTINUE_ROUTE) == []
    assert await _deleted(account) == []
