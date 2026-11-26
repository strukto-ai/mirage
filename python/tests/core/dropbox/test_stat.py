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
from mirage.core.dropbox.read import read
from mirage.core.dropbox.readdir import readdir
from mirage.core.dropbox.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.handed import call

METADATA_ROUTE = "/2/files/get_metadata"
LIST_ROUTE = "/2/files/list_folder"
A = PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/")


async def _asked(account) -> list[str]:
    """The path each get_metadata since recording asked for."""
    sent = await account.run.bodies("POST", METADATA_ROUTE)
    return [body["path"] for body in sent]


@pytest.mark.asyncio
async def test_stat_mount_root_is_directory(account):
    await account.run.record_requests()
    out = await stat(
        account.accessor(), PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert out.type == FileType.DIRECTORY
    assert out.name == "/"
    assert await account.run.requests() == []


@pytest.mark.asyncio
async def test_stat_file_from_api(account):
    # Dropbox addresses by path: stat is one get_metadata.
    stored = await account.put("/a.txt", b"hello")
    out = await stat(account.accessor(), PathSpec.from_str_path("/a.txt"))
    assert out.content == ContentType.TEXT
    assert out.name == "a.txt"
    assert out.size == 5
    assert out.modified == stored["server_modified"]
    assert out.fingerprint == stored["content_hash"]
    assert out.extra["dropbox_id"] == stored["id"]
    assert out.extra["resource_type"] == "dropbox/file"


@pytest.mark.asyncio
async def test_stat_folder_from_api(account):
    made = await account.mkdir("/docs")
    out = await stat(account.accessor(), PathSpec.from_str_path("/docs"))
    assert out.type == FileType.DIRECTORY
    assert out.name == "docs"
    assert out.size is None
    assert out.extra["dropbox_id"] == made["id"]


@pytest.mark.asyncio
async def test_stat_missing_is_enoent(account):
    with pytest.raises(FileNotFoundError) as caught:
        await stat(account.accessor(), PathSpec.from_str_path("/ghost.txt"))
    assert "/ghost.txt" in str(caught.value)


@pytest.mark.asyncio
async def test_stat_non_409_propagates(account):
    # A rate-limit or server error is not absence: it must surface.
    await account.run.answer_next("POST", METADATA_ROUTE, 500)
    with pytest.raises(DropboxApiError) as caught:
        await stat(account.accessor(), PathSpec.from_str_path("/a.txt"))
    assert caught.value.status == 500


_FALLBACK_CASES = [
    (
        {
            ".tag": "file",
            "id": "id:x",
            "name": "f.txt",
            "client_modified": "2026-01-02T00:00:00Z",
            "size": 3,
        },
        "id:x",
        3,
        "2026-01-02T00:00:00Z",
    ),
    (
        {".tag": "file", "id": "id:x", "name": "f.txt", "size": 3},
        "id:x",
        3,
        "",
    ),
    (
        {
            ".tag": "file",
            "name": "f.txt",
            "path_display": "/d/f.txt",
            "size": 3,
        },
        "/d/f.txt",
        3,
        "",
    ),
    ({".tag": "file", "name": "f.txt", "size": 3}, "f.txt", 3, ""),
    ({".tag": "file", "id": "id:x", "name": "f.txt"}, "id:x", None, ""),
    (
        {".tag": "file", "id": "id:x", "name": "f.txt", "size": "big"},
        "id:x",
        None,
        "",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("entry, dropbox_id, size, modified", _FALLBACK_CASES)
async def test_stat_entry_field_fallbacks(
    account, entry, dropbox_id, size, modified
):
    # stat_from_entry's fallbacks: server_modified→client_modified→"",
    # id→path_display→name, no content_hash is no token, and a
    # non-int/absent size renders as None (the unknown-size machinery,
    # never a fabricated number). Answers the fake never gives.
    await account.run.answer_next("POST", METADATA_ROUTE, 200, entry, times=5)
    out = await stat(account.accessor(), PathSpec.from_str_path("/f.txt"))
    assert out.extra["dropbox_id"] == dropbox_id
    assert out.size == size
    assert out.modified == modified
    assert out.fingerprint is None


@pytest.mark.asyncio
async def test_stat_under_mount_prefix(account):
    # Every other test runs on an unprefixed mount; this pins the prefix
    # arithmetic of the path get_metadata is asked for.
    await account.put("/a.txt", b"hello")
    await account.run.record_requests()
    out = await stat(
        account.accessor(),
        PathSpec(
            virtual="/dropbox/a.txt",
            directory="/dropbox",
            vfs_path=mount_key("/dropbox/a.txt", "/dropbox"),
        ),
    )
    assert out.content == ContentType.TEXT
    assert out.name == "a.txt"
    assert out.size == 5
    assert await _asked(account) == ["/a.txt"]


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(account):
    # The fskit invariant behind sizes_always_known: the size stat serves
    # from the listing must equal the byte length a read delivers, 0-byte
    # files included.
    await account.put("/a.txt", b"hello")
    await account.put("/empty.txt", b"")
    await account.put("/docs/b.bin", b"abc")
    accessor = account.accessor()
    files: list[str] = []
    stack = ["/"]
    while stack:
        current = stack.pop()
        listing = await readdir(accessor, PathSpec.from_str_path(current))
        for child in listing:
            trimmed = f"{current.rstrip('/')}/{child.name}"
            spec = PathSpec.from_str_path(trimmed)
            info = await stat(accessor, spec)
            if info.type == FileType.DIRECTORY:
                stack.append(trimmed)
                continue
            assert info.size is not None, trimmed
            data = await call(read, readdir, accessor, spec)
            assert info.size == len(data), trimmed
            files.append(trimmed)
    assert sorted(files) == ["/a.txt", "/docs/b.bin", "/empty.txt"]


@pytest.mark.asyncio
async def test_stat_asks_one_lookup(account):
    # One get_metadata, never a listing of the parent: the mount keeps
    # listings and answers a listed path itself.
    stored = await account.put("/a.txt", b"hello")
    await account.run.record_requests()
    out = await stat(account.accessor(), A)
    assert out.fingerprint == stored["content_hash"]
    assert await account.run.bodies("POST", LIST_ROUTE) == []
    assert await _asked(account) == ["/a.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status, summary, raised",
    [
        (409, "path/not_found/..", FileNotFoundError),
        (409, "path/not_folder/..", FileNotFoundError),
        (409, "path/restricted_content/..", DropboxApiError),
        (502, "path/not_found/..", DropboxApiError),
    ],
    ids=["not-found", "not-folder", "restricted", "5xx"],
)
async def test_stat_from_api_reads_only_a_miss_as_enoent(
    account, status, summary, raised
):
    # A restricted file exists, so a fresh probe must not hear ENOENT and
    # drop its overlay; a 5xx body naming not_found is a relay's.
    await account.run.answer_next(
        "POST", METADATA_ROUTE, status, {"error_summary": summary}
    )
    with pytest.raises(raised):
        await stat(account.accessor(), A)


@pytest.mark.asyncio
async def test_stat_from_api_answer_in_another_case_is_enoent(account):
    # get_metadata matches case-insensitively where a listing is exact:
    # Dropbox answers /A.TXT with a.txt.
    stored = await account.put("/a.txt", b"hello")
    await account.run.answer_next("POST", METADATA_ROUTE, 200, stored, times=5)
    with pytest.raises(FileNotFoundError):
        await stat(account.accessor(), PathSpec.from_str_path("/A.TXT"))
