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


async def _moves(account) -> list[tuple[str, str]]:
    bodies = await account.run.bodies("POST", MOVE_ROUTE)
    return [(body["from_path"], body["to_path"]) for body in bodies]


@pytest.mark.asyncio
async def test_rename_replaces_existing_destination_file(account):
    # Dropbox refuses a move onto a file; mv replaces it, so the file moves
    # aside under a staged name, the moved file takes its name, and the
    # file set aside goes.
    await account.put("/a.txt", b"mine")
    await account.put("/b.txt", b"theirs")
    await account.run.record_requests()
    await _rename(account, "/a.txt", "/b.txt")
    tried, aside, landed = await _moves(account)
    assert tried == landed == ("/a.txt", "/b.txt")
    assert aside[0] == "/b.txt" and aside[1].startswith("/b.txt.mirage-")
    assert await _deleted(account) == [aside[1]]
    assert await account.names() == ["b.txt"]
    assert await account.read("/b.txt") == b"mine"


@pytest.mark.asyncio
async def test_rename_conflict_replaces_empty_dir_destination(account):
    await account.put("/src/x.txt", b"x")
    await account.mkdir("/dst")
    await account.run.record_requests()
    await _rename(account, "/src", "/dst")
    _, aside, _ = await _moves(account)
    assert aside[0] == "/dst" and aside[1].startswith("/dst.mirage-")
    assert await _deleted(account) == [aside[1]]
    assert await account.names() == ["dst"]
    assert await account.names("/dst") == ["x.txt"]


@pytest.mark.asyncio
async def test_rename_refused_set_aside_keeps_the_destination(account):
    # The move meets the taken name first, then moving the file aside is
    # refused: nothing moved, so nothing is put back.
    await account.put("/a.txt", b"mine")
    await account.put("/b.txt", b"theirs")
    await account.run.answer_next(
        "POST", MOVE_ROUTE, 409, {"error_summary": "to/conflict/file/.."}
    )
    await account.run.answer_next(
        "POST", MOVE_ROUTE, 409, {"error_summary": "from_write/no_write/.."}
    )
    with pytest.raises(DropboxApiError):
        await _rename(account, "/a.txt", "/b.txt")
    assert await account.names() == ["a.txt", "b.txt"]
    assert await account.read("/b.txt") == b"theirs"


@pytest.mark.asyncio
async def test_rename_refused_delete_moves_the_file_back(account):
    await account.put("/src/a.txt", b"mine")
    await account.put("/b.txt", b"theirs")
    await account.run.answer_next(
        "POST",
        DELETE_ROUTE,
        409,
        {"error_summary": "path_lookup/restricted_content/.."},
    )
    with pytest.raises(DropboxApiError):
        await _rename(account, "/src/a.txt", "/b.txt")
    assert await account.names() == ["b.txt", "src"]
    assert await account.names("/src") == ["a.txt"]
    assert await account.read("/b.txt") == b"theirs"


@pytest.mark.asyncio
async def test_rename_keeps_a_folder_given_a_child_while_moving(account):
    # Another client writes into the empty folder after the first probe,
    # while the source moves beside it (the move after that probe): the
    # probe made just before the delete sees the child, so the folder stays
    # and the source goes back.
    await account.put("/src/x.txt", b"x")
    await account.mkdir("/dst")
    await account.run.before_next(
        [("POST", LIST_ROUTE)],
        lambda: account.run.before_next(
            [("POST", MOVE_ROUTE)],
            lambda: account.put("/dst/late.txt", b"late"),
        ),
    )
    with pytest.raises(OSError) as caught:
        await _rename(account, "/src", "/dst")
    assert caught.value.errno == errno.ENOTEMPTY
    assert await account.names() == ["dst", "src"]
    assert await account.names("/dst") == ["late.txt"]
    assert await account.names("/src") == ["x.txt"]


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


async def _at_move(account, nth: int, change, status: int | None) -> None:
    """Run ``change`` while the ``nth`` move from now waits, then answer it
    with ``status``."""
    if nth == 1:
        await account.run.before_next([("POST", MOVE_ROUTE)], change, status)
        return
    await account.run.before_next(
        [("POST", MOVE_ROUTE)],
        lambda: _at_move(account, nth - 1, change, status),
    )


@pytest.mark.asyncio
async def test_rename_whose_landing_went_through_is_finished(account):
    # The third move (the first met the taken name, the second set the
    # file there aside) lands, but its answer is lost: the moved file is
    # found at the name by its id, and the file set aside is deleted.
    await account.put("/a.txt", b"mine")
    await account.put("/b.txt", b"theirs")
    await _at_move(
        account,
        3,
        lambda: account.run.call(
            "POST",
            MOVE_ROUTE,
            json={"from_path": "/a.txt", "to_path": "/b.txt"},
        ),
        502,
    )
    await _rename(account, "/a.txt", "/b.txt")
    assert await account.names() == ["b.txt"]
    assert await account.read("/b.txt") == b"mine"


@pytest.mark.asyncio
async def test_rename_take_back_leaves_a_landing_another_client_wrote(
    account,
):
    # The delete of the file set aside is refused, and another client
    # wrote onto the moved file meanwhile: its rev moved on, so it stays
    # at the name rather than going back with that write.
    await account.put("/a.txt", b"mine")
    await account.put("/b.txt", b"theirs")
    await account.run.before_next(
        [("POST", DELETE_ROUTE)],
        lambda: account.put("/b.txt", b"later"),
        409,
    )
    with pytest.raises(DropboxApiError):
        await _rename(account, "/a.txt", "/b.txt")
    assert await account.read("/b.txt") == b"later"
    assert "a.txt" not in await account.names()
