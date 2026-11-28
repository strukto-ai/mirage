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
from mirage.core.dropbox.copy import copy, dir_copy
from mirage.types import PathSpec

COPY_ROUTE = "/2/files/copy_v2"
DELETE_ROUTE = "/2/files/delete_v2"
MOVE_ROUTE = "/2/files/move_v2"


def _pairs(bodies: list) -> list[tuple[str, str]]:
    return [(body["from_path"], body["to_path"]) for body in bodies]


@pytest.mark.asyncio
async def test_copy_maps_paths_under_mount_root(account):
    await account.put("/Team/a.txt", b"a")
    await account.run.record_requests()
    await copy(
        account.accessor("/Team"),
        PathSpec.from_str_path("/a.txt"),
        PathSpec.from_str_path("/b.txt"),
    )
    assert _pairs(await account.run.bodies("POST", COPY_ROUTE)) == [
        ("/Team/a.txt", "/Team/b.txt")
    ]
    assert await account.read("/Team/b.txt") == b"a"


@pytest.mark.asyncio
async def test_copy_replaces_existing_destination_file(account):
    # Dropbox refuses a copy onto a file; cp replaces it, so the copy lands
    # beside the file under a staged name, the file goes, and the copy
    # takes its name.
    await account.put("/a.txt", b"mine")
    await account.put("/b.txt", b"theirs")
    await account.run.record_requests()
    await copy(
        account.accessor(),
        PathSpec.from_str_path("/a.txt"),
        PathSpec.from_str_path("/b.txt"),
    )
    deleted = await account.run.bodies("POST", DELETE_ROUTE)
    assert [body["path"] for body in deleted] == ["/b.txt"]
    tried, landed = _pairs(await account.run.bodies("POST", COPY_ROUTE))
    assert tried == ("/a.txt", "/b.txt")
    assert landed[1].startswith("/b.txt.mirage-")
    named = _pairs(await account.run.bodies("POST", MOVE_ROUTE))
    assert named == [(landed[1], "/b.txt")]
    assert await account.names() == ["a.txt", "b.txt"]
    assert await account.read("/b.txt") == b"mine"


@pytest.mark.asyncio
async def test_copy_refused_delete_drops_the_copy(account):
    await account.put("/a.txt", b"mine")
    await account.put("/b.txt", b"theirs")
    await account.run.answer_next(
        "POST",
        DELETE_ROUTE,
        409,
        {"error_summary": "path_lookup/restricted_content/.."},
    )
    with pytest.raises(DropboxApiError):
        await copy(
            account.accessor(),
            PathSpec.from_str_path("/a.txt"),
            PathSpec.from_str_path("/b.txt"),
        )
    assert await account.names() == ["a.txt", "b.txt"]
    assert await account.read("/b.txt") == b"theirs"


@pytest.mark.asyncio
async def test_dir_copy_copies_the_tree_in_one_request(account):
    await account.put("/Team/src/x.txt", b"x")
    await account.run.record_requests()
    await dir_copy(
        account.accessor("/Team"),
        PathSpec.from_str_path("/src"),
        PathSpec.from_str_path("/dst"),
    )
    assert _pairs(await account.run.bodies("POST", COPY_ROUTE)) == [
        ("/Team/src", "/Team/dst")
    ]
    assert await account.read("/Team/dst/x.txt") == b"x"
