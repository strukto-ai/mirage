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

import hashlib

import pytest

from mirage.cache.index.ram import ListingCheckStore, RAMIndexCacheStore
from mirage.core.box.client import BoxApiError
from mirage.core.box.read import read
from mirage.core.box.readdir import readdir
from mirage.core.box.stat import stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from tests.fixtures.handed import call

ROOT = PathSpec(vfs_path="", virtual="/", directory="/")
FLAT = PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/")
DEEP = PathSpec(vfs_path="a/b/c.txt", virtual="/a/b/c.txt", directory="/a/b")
HELLO = b"hello"
SHA_HELLO = hashlib.sha1(HELLO).hexdigest()
SHA_FAST = "fast"
NO_SUCH_ID = "9"
FOLDER_ROUTE = "/2.0/folders/:folder_id"
ITEMS_ROUTE = "/2.0/folders/:folder_id/items"
FILE_ROUTE = "/2.0/files/:file_id"
ALL_FILES = {"type": "folder", "id": "0", "name": "All Files"}
TRASH = {"type": "folder", "id": "1", "name": "Trash"}


def _folder(folder_id: str) -> str:
    return f"GET /2.0/folders/{folder_id}"


def _items(folder_id: str) -> str:
    return f"GET /2.0/folders/{folder_id}/items"


def _file(file_id: str) -> str:
    return f"GET /2.0/files/{file_id}"


async def _deep(account, root: str = "0") -> tuple[str, str, str]:
    a = await account.mkdir("a", root)
    b = await account.mkdir("b", a)
    return a, b, await account.put("c.txt", HELLO, b)


async def _scratch_stat(
    accessor, virtual="/a/b/c.txt", row_id="", kind="box/file"
):
    src = RAMIndexCacheStore()
    parent, name = virtual.rsplit("/", 1)
    row = FileStat(
        name=name,
        type=(FileType.DIRECTORY if kind == "box/folder" else FileType.FILE),
        extra={"box_id": row_id},
    )
    await src.set_dir(parent, [(name, row)])
    return await stat(
        accessor,
        PathSpec(vfs_path="a/b/c.txt", virtual=virtual, directory=parent),
        index=ListingCheckStore(hints=src),
    )


async def _answer_instead(account, file_id: str, **change) -> None:
    answer = await account.file_info(file_id)
    answer["sha1"] = SHA_FAST
    answer.update(change)
    await account.run.answer_next("GET", FILE_ROUTE, 200, body=answer)


@pytest.mark.asyncio
async def test_stat_root_fetches_folder_info(account):
    await account.run.record_requests()
    info = await stat(account.accessor(), ROOT)
    assert await account.run.requests() == [_folder("0")]
    assert info.type == FileType.DIRECTORY
    assert info.name == "/"
    assert info.modified == (await account.folder_info("0"))["modified_at"]


@pytest.mark.asyncio
async def test_stat_file_carries_box_metadata(account):
    file_id = await account.put("a.txt", HELLO)
    info = await call(stat, readdir, account.accessor(), FLAT)
    assert info.content == ContentType.TEXT
    assert info.size == 5
    assert info.modified == (await account.file_info(file_id))["modified_at"]
    assert info.fingerprint == SHA_HELLO
    assert info.extra["box_id"] == file_id
    assert info.extra["resource_type"] == "box/file"


@pytest.mark.asyncio
async def test_stat_folder_is_directory(account):
    docs = await account.mkdir("docs")
    info = await call(
        stat,
        readdir,
        account.accessor(),
        PathSpec(vfs_path="docs", virtual="/docs", directory="/"),
    )
    assert info.type == FileType.DIRECTORY
    assert info.extra["box_id"] == docs


@pytest.mark.asyncio
async def test_stat_missing_raises(account):
    with pytest.raises(FileNotFoundError):
        await call(
            stat,
            readdir,
            account.accessor(),
            PathSpec(vfs_path="ghost", virtual="/ghost", directory="/"),
        )


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(account):
    # The fskit invariant behind sizes_always_known: the size stat serves
    # from the listing must equal the byte length a read delivers, 0-byte
    # files included; weblinks never appear at all.
    docs = await account.mkdir("docs")
    await account.put("a.txt", HELLO)
    await account.put("empty.txt", b"")
    await account.web_link("homepage")
    await account.put("b.bin", b"abc", docs)
    accessor = account.accessor()
    files: list[str] = []
    stack = ["/"]
    while stack:
        current = stack.pop()
        listing = await call(
            readdir, readdir, accessor, PathSpec.from_str_path(current)
        )
        for child in listing:
            trimmed = current.rstrip("/") + "/" + child.name
            spec = PathSpec.from_str_path(trimmed)
            info = await call(stat, readdir, accessor, spec)
            if info.type == FileType.DIRECTORY:
                stack.append(trimmed)
                continue
            assert info.size is not None, trimmed
            body = await call(read, readdir, accessor, spec)
            assert info.size == len(body), trimmed
            files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]


@pytest.mark.asyncio
async def test_stat_direct_resolve_hides_weblinks(account):
    # Weblinks are filtered from listings; a check's resolve_item walk must
    # not resurface one as a sizeless, unreadable entry.
    await account.web_link("homepage")
    with pytest.raises(FileNotFoundError):
        await stat(
            account.accessor(),
            PathSpec(vfs_path="homepage", virtual="/homepage", directory="/"),
            index=ListingCheckStore(),
        )


@pytest.mark.asyncio
async def test_stat_root_reads_a_404_as_absence(account):
    with pytest.raises(FileNotFoundError):
        await stat(account.accessor(NO_SUCH_ID), ROOT)


@pytest.mark.asyncio
async def test_stat_root_keeps_a_server_error_a_failure(account):
    await account.run.answer_next("GET", FOLDER_ROUTE, 500)
    with pytest.raises(BoxApiError) as caught:
        await stat(account.accessor(), ROOT)
    assert caught.value.status == 500


async def _list_without_sha1(account) -> str:
    await account.put("a.txt", HELLO)
    listing = await account.run.call("GET", "/2.0/folders/0/items")
    for row in listing["entries"]:
        del row["sha1"]
    await account.run.answer_next("GET", ITEMS_ROUTE, 200, body=listing)
    return listing["entries"][0]["modified_at"]


@pytest.mark.asyncio
async def test_a_sha1_less_row_stats_with_no_token(account):
    # modified_at is no content token: two same-size edits in one second
    # share it, so a file Box gives no sha1 stats with none.
    modified = await _list_without_sha1(account)
    info = await call(stat, readdir, account.accessor(), FLAT)
    assert info.fingerprint is None
    assert info.modified == modified


@pytest.mark.asyncio
async def test_a_direct_resolve_of_a_sha1_less_item_has_no_token(account):
    modified = await _list_without_sha1(account)
    info = await stat(account.accessor(), FLAT, index=ListingCheckStore())
    assert info.fingerprint is None
    assert info.modified == modified


@pytest.mark.asyncio
async def test_a_listed_sha1_is_the_stat_token(account):
    await account.put("a.txt", HELLO)
    info = await call(stat, readdir, account.accessor(), FLAT)
    assert info.fingerprint == SHA_HELLO


@pytest.mark.asyncio
async def test_a_valid_hint_is_one_request_and_the_walks_answer(account):
    a, b, file_id = await _deep(account)
    accessor = account.accessor()
    await account.run.record_requests()
    fast = await _scratch_stat(accessor, row_id=file_id)
    assert await account.run.requests() == [_file(file_id)]
    await account.run.record_requests()
    walked = await _scratch_stat(accessor)
    # The command reuses the probe's stat, so the fast path must build the
    # stat the walk would have: compared with the real walk, not by hand.
    assert await account.run.requests() == [_items("0"), _items(a), _items(b)]
    assert fast == walked
    assert fast.fingerprint == SHA_HELLO


@pytest.mark.asyncio
async def test_only_a_scratch_store_takes_the_one_request_path(account):
    file_id = (await _deep(account))[2]
    row = FileStat(name="c.txt", type=FileType.FILE, extra={"box_id": file_id})
    await account.run.record_requests()
    info = await stat(account.accessor(), DEEP, row, RAMIndexCacheStore())
    assert info is row
    assert await account.run.requests() == []


@pytest.mark.asyncio
async def test_an_unusable_hint_walks_without_asking_for_it(account):
    a, b, _ = await _deep(account)
    await account.run.record_requests()
    info = await _scratch_stat(account.accessor())
    assert await account.run.requests() == [_items("0"), _items(a), _items(b)]
    assert info.fingerprint == SHA_HELLO


@pytest.mark.asyncio
async def test_a_folder_hint_is_asked_by_id_then_walked(account):
    # A folder is asked for by id as a file is; one gone by id is walked.
    a, b, _ = await _deep(account)
    await account.run.record_requests()
    info = await _scratch_stat(
        account.accessor(), row_id=NO_SUCH_ID, kind="box/folder"
    )
    assert await account.run.requests() == [
        _folder(NO_SUCH_ID),
        _items("0"),
        _items(a),
        _items(b),
    ]
    assert info.fingerprint == SHA_HELLO


@pytest.mark.asyncio
async def test_no_hint_walks_as_today(account):
    a, b, _ = await _deep(account)
    await account.run.record_requests()
    info = await stat(account.accessor(), DEEP, index=ListingCheckStore())
    assert await account.run.requests() == [_items("0"), _items(a), _items(b)]
    assert info.fingerprint == SHA_HELLO


async def _move_away(account, a: str, b: str, file_id: str) -> list[str]:
    x = await account.mkdir("x", a)
    await account.run.call(
        "PUT", f"/2.0/files/{file_id}", json={"parent": {"id": x}}
    )
    return [_items("0"), _items(a), _items(b)]


async def _rename_parent(account, a: str, b: str, file_id: str) -> list[str]:
    await account.run.call("PUT", f"/2.0/folders/{b}", json={"name": "b2"})
    return [_items("0"), _items(a)]


async def _rename_case(account, a: str, b: str, file_id: str) -> list[str]:
    await account.run.call(
        "PUT", f"/2.0/files/{file_id}", json={"name": "C.txt"}
    )
    return [_items("0"), _items(a), _items(b)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [_move_away, _rename_parent, _rename_case],
    ids=["moved", "parent-renamed", "case-only"],
)
async def test_a_hinted_file_that_left_the_path_is_walked_for_and_gone(
    account, change
):
    # Only the path-name check fails; a case-only rename is one a listing
    # tells apart.
    a, b, file_id = await _deep(account)
    walk = await change(account, a, b, file_id)
    await account.run.record_requests()
    with pytest.raises(FileNotFoundError):
        await _scratch_stat(account.accessor(), row_id=file_id)
    assert await account.run.requests() == [_file(file_id), *walk]


@pytest.mark.asyncio
async def test_a_hint_to_a_deleted_file_walks_to_the_one_there_now(account):
    a, b, old = await _deep(account)
    await account.run.call("DELETE", f"/2.0/files/{old}")
    await account.put("c.txt", b"other", b)
    await account.run.record_requests()
    info = await _scratch_stat(account.accessor(), row_id=old)
    assert await account.run.requests() == [
        _file(old),
        _items("0"),
        _items(a),
        _items(b),
    ]
    assert info.fingerprint == hashlib.sha1(b"other").hexdigest()


@pytest.mark.asyncio
async def test_a_hint_box_refuses_to_answer_falls_back_to_the_walk(account):
    a, b, file_id = await _deep(account)
    await account.run.answer_next("GET", FILE_ROUTE, 403)
    await account.run.record_requests()
    info = await _scratch_stat(account.accessor(), row_id=file_id)
    assert await account.run.requests() == [
        _file(file_id),
        _items("0"),
        _items(a),
        _items(b),
    ]
    assert info.fingerprint == SHA_HELLO


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [{"item_status": "trashed"}, {"type": "web_link"}],
    ids=["trashed", "not-a-file"],
)
async def test_an_answer_failing_one_check_falls_back_to_the_walk(
    account, change
):
    # Box's own answer for the file with one field changed, so only the
    # active-status check or only the is-a-file check fails.
    a, b, file_id = await _deep(account)
    await _answer_instead(account, file_id, **change)
    await account.run.record_requests()
    info = await _scratch_stat(account.accessor(), row_id=file_id)
    assert await account.run.requests() == [
        _file(file_id),
        _items("0"),
        _items(a),
        _items(b),
    ]
    assert info.fingerprint == SHA_HELLO


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "above",
    [
        # The mount root itself in Trash: the All-Files-root and no-Trash
        # checks both fail.
        [TRASH],
        # Only the no-Trash check fails, should Box render Trash under 0.
        [ALL_FILES, TRASH],
    ],
    ids=["root-in-trash", "trash-under-all-files"],
)
async def test_a_file_under_a_trashed_mount_root_is_gone(account, above):
    root = await account.mkdir("r")
    file_id = (await _deep(account, root))[2]
    chain = (await account.file_info(file_id))["path_collection"]["entries"]
    await _answer_instead(
        account,
        file_id,
        path_collection={
            "total_count": len(above) + 3,
            "entries": [*above, *chain[1:]],
        },
    )
    await account.run.call("DELETE", f"/2.0/folders/{root}?recursive=true")
    await account.run.record_requests()
    with pytest.raises(FileNotFoundError):
        await _scratch_stat(
            account.accessor(root), virtual="/m/a/b/c.txt", row_id=file_id
        )
    # The trashed root's listing 404s for the walk.
    assert await account.run.requests() == [_file(file_id), _items(root)]


@pytest.mark.asyncio
async def test_a_chain_not_rooted_at_all_files_falls_back(account):
    # The mount root reached from a folder that is not 0. Only the
    # All-Files-root check rejects it, and the walk then answers.
    root = await account.mkdir("r")
    a, b, file_id = await _deep(account, root)
    chain = (await account.file_info(file_id))["path_collection"]["entries"]
    await _answer_instead(
        account,
        file_id,
        path_collection={
            "total_count": 4,
            "entries": [
                {"type": "folder", "id": "X", "name": "x"},
                *chain[1:],
            ],
        },
    )
    await account.run.record_requests()
    info = await _scratch_stat(
        account.accessor(root), virtual="/m/a/b/c.txt", row_id=file_id
    )
    assert info.fingerprint == SHA_HELLO
    assert await account.run.requests() == [
        _file(file_id),
        _items(root),
        _items(a),
        _items(b),
    ]


@pytest.mark.asyncio
async def test_a_mount_rooted_below_all_files_takes_the_one_request_path(
    account,
):
    root = await account.mkdir("r", await account.mkdir("x"))
    file_id = (await _deep(account, root))[2]
    await account.run.record_requests()
    info = await _scratch_stat(
        account.accessor(root), virtual="/m/a/b/c.txt", row_id=file_id
    )
    assert await account.run.requests() == [_file(file_id)]
    assert info.fingerprint == SHA_HELLO


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 429, 500])
async def test_a_failed_point_lookup_propagates(account, status):
    file_id = (await _deep(account))[2]
    await account.run.answer_next("GET", FILE_ROUTE, status)
    await account.run.record_requests()
    with pytest.raises(BoxApiError) as exc:
        await _scratch_stat(account.accessor(), row_id=file_id)
    assert exc.value.status == status
    assert await account.run.requests() == [_file(file_id)]


@pytest.mark.asyncio
async def test_an_answer_without_item_status_is_not_taken_as_active(account):
    # Box sends item_status when asked; an answer without it proves nothing
    # about the file being active, so the walk decides.
    a, b, file_id = await _deep(account)
    answer = await account.file_info(file_id)
    answer["sha1"] = SHA_FAST
    del answer["item_status"]
    await account.run.answer_next("GET", FILE_ROUTE, 200, body=answer)
    await account.run.record_requests()
    info = await _scratch_stat(account.accessor(), row_id=file_id)
    assert info.fingerprint == SHA_HELLO
    assert await account.run.requests() == [
        _file(file_id),
        _items("0"),
        _items(a),
        _items(b),
    ]


@pytest.mark.asyncio
async def test_a_rooted_mount_stats_its_root_folder_not_all_files(account):
    root = await account.mkdir("r")
    await account.run.record_requests()
    info = await stat(account.accessor(root), ROOT)
    assert info.extra["box_id"] == root
    assert await account.run.requests() == [_folder(root)]
