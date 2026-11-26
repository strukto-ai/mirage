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

import json
from dataclasses import replace

import pytest

from mirage.cache.context import capture_read
from mirage.cache.types import WriteContext
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.read import read, read_stream
from mirage.core.dropbox.readdir import readdir
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.handed import call, entry_at

NOTE = FileStat(name="note.txt", type=FileType.FILE)
DOWNLOAD_ROUTE = "/2/files/download"
LIST_ROUTE = "/2/files/list_folder"
DATA = b"0123456789"
A = PathSpec(virtual="/a.txt", directory="/", vfs_path="a.txt")
NOTE_PATH = PathSpec(virtual="/note.txt", directory="/", vfs_path="note.txt")
UNDER_PREFIX = PathSpec(
    virtual="/dropbox/note.txt",
    directory="/dropbox",
    vfs_path=mount_key("/dropbox/note.txt", "/dropbox"),
)


async def _downloads(account) -> list[tuple[str, str | None]]:
    """Each download since recording: the path it named and its Range."""
    sent = await account.run.headers("POST", DOWNLOAD_ROUTE)
    return [
        (json.loads(h["dropbox-api-arg"])["path"], h.get("range"))
        for h in sent
    ]


async def _lagging(account) -> str:
    """``/a.txt`` holding DATA under a listing that lags the bytes: Dropbox's
    own listing with a stale content_hash, for every listing the read makes.
    Returns the hash of DATA."""
    stored = await account.put("/a.txt", DATA)
    listing = await account.run.call(
        "POST", LIST_ROUTE, json={"path": ""}
    )
    for entry in listing["entries"]:
        entry["content_hash"] = "stale"
    await account.run.answer_next("POST", LIST_ROUTE, 200, listing, times=10)
    return stored["content_hash"]


@pytest.mark.asyncio
async def test_read_strips_mount_prefix(account):
    await account.put("/note.txt", b"hi!")
    await account.run.record_requests("dropbox-api-arg", "range")
    data = await call(read, readdir, account.accessor(), UNDER_PREFIX)
    assert data == b"hi!"
    assert await _downloads(account) == [("/note.txt", None)]


@pytest.mark.asyncio
async def test_a_ranged_read_asks_dropbox_for_the_range(account):
    await account.put("/note.txt", b"hi!")
    await account.run.record_requests("dropbox-api-arg", "range")
    data = await call(
        read, readdir, account.accessor(), NOTE_PATH, offset=1, size=2
    )
    assert data == b"i!"
    assert await _downloads(account) == [("/note.txt", "bytes=1-2")]


@pytest.mark.asyncio
async def test_a_ranged_read_of_a_handed_row_carries_the_range(account):
    # Dropbox downloads by path: the row only says a file is there.
    await account.put("/note.txt", b"hi!")
    await account.run.record_requests("dropbox-api-arg", "range")
    await read(account.accessor(), NOTE_PATH, offset=1, size=2, entry=NOTE)
    assert await _downloads(account) == [("/note.txt", "bytes=1-2")]


@pytest.mark.asyncio
async def test_read_downloads_through_subfolder_root(account):
    await account.put("/Team/data/note.txt", b"hi")
    await account.run.record_requests("dropbox-api-arg", "range")
    data = await call(
        read, readdir, account.accessor("Team/data"), UNDER_PREFIX
    )
    assert data == b"hi"
    assert await _downloads(account) == [("/Team/data/note.txt", None)]


@pytest.mark.asyncio
async def test_read_folder_raises_isadirectory(account):
    await account.mkdir("/docs")
    with pytest.raises(IsADirectoryError):
        await call(
            read,
            readdir,
            account.accessor(),
            PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
        )


@pytest.mark.asyncio
async def test_read_missing_raises_enoent(account):
    with pytest.raises(FileNotFoundError):
        await call(
            read,
            readdir,
            account.accessor(),
            PathSpec(
                vfs_path="missing.txt", virtual="/missing.txt", directory="/"
            ),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "offset, size, expected",
    [(0, None, DATA), (2, 3, b"234")],
    ids=["full", "ranged"],
)
async def test_every_byte_read_records_the_content_hash(
    account, offset, size, expected
):
    # A read's token comes from its own download, never from the row that
    # resolved the entry; a ranged read is answered 206 and still carries
    # Dropbox-API-Result.
    whole = await _lagging(account)
    accessor = account.accessor()
    scope = RecordingScope()
    try:
        data = await call(read, readdir, accessor, A, offset=offset, size=size)
    finally:
        scope.close()
        await accessor.close()
    assert data == expected
    assert [(r.op, r.bytes, r.fingerprint) for r in scope.records] == [
        ("read", len(expected), whole)
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("recorded", [True, False], ids=["line", "bare"])
async def test_a_stream_records_the_content_hash(account, recorded):
    # Outside a shell line (FUSE, a programmatic read) there is no
    # recorder, and the stream must still stream.
    whole = await _lagging(account)
    accessor = account.accessor()
    scope = RecordingScope() if recorded else None
    try:
        entry = await entry_at(readdir, accessor, A)
        chunks = [c async for c in read_stream(accessor, A, entry)]
    finally:
        if scope is not None:
            scope.close()
        await accessor.close()
    assert b"".join(chunks) == DATA
    if scope is not None:
        assert [(r.op, r.bytes, r.fingerprint) for r in scope.records] == [
            ("read", len(DATA), whole)
        ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status, summary, raised",
    [
        (409, "path/not_found/..", FileNotFoundError),
        (409, "path/not_file/..", IsADirectoryError),
        (409, "path/restricted_content/..", DropboxApiError),
        (500, "path/not_found/..", DropboxApiError),
    ],
    ids=["missing", "folder", "restricted", "server-error"],
)
async def test_a_listed_read_maps_only_a_miss_to_enoent(
    account, status, summary, raised
):
    # A miss says the listed file is no longer there, which the mount reads
    # as a stale row and lists again; anything else is a failure.
    await account.run.answer_next(
        "POST", DOWNLOAD_ROUTE, status, {"error_summary": summary}
    )
    with pytest.raises(raised):
        await read(account.accessor(), A, entry=NOTE)


async def _nothing(_path: PathSpec) -> str | None:
    return None


async def _none_all(paths: list[PathSpec]) -> list[str | None]:
    return [None] * len(paths)


async def _ignore(*_args: PathSpec | str) -> None:
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "conditional, offset, size, whole",
    [(True, 0, None, True), (True, 2, 3, False), (False, 0, None, False)],
    ids=["whole", "ranged", "unconditional"],
)
async def test_a_whole_read_publishes_its_token_on_a_conditional_mount(
    account, conditional, offset, size, whole
):
    stored = await account.put("/a.txt", DATA)
    context = WriteContext(
        vfs="dropbox",
        conditions=frozenset({"put", "copy", "delete"}),
        read_version=_nothing,
        read_versions=_none_all,
        drop=_ignore,
        keep=_ignore,
    )
    prev = bind_caller(
        replace(
            current_caller(), write_context=context if conditional else None
        )
    )
    accessor = account.accessor()
    try:
        _, tokens = await capture_read(
            A.virtual,
            lambda: call(read, readdir, accessor, A, offset=offset, size=size),
        )
    finally:
        reset_caller(prev)
        await accessor.close()
    assert tokens == ([stored["content_hash"]] if whole else [])
