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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.read import read, stream
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.ranges import ByteWindow
from mirage.vfs.dropbox.config import DropboxConfig
from tests.fixtures.dropbox_api import FakeDropbox, content_hash, serve


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(
        client_id="c",
        client_secret="s",
        refresh_token="r",
        root_path=root_path,
    )
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


FILE_LISTING = [
    {
        ".tag": "file",
        "id": "id:1",
        "name": "note.txt",
        "path_display": "/note.txt",
        "size": 5,
    }
]


@pytest.mark.asyncio
async def test_read_strips_mount_prefix(index):
    with patch(
        "mirage.core.dropbox.readdir.list_folder",
        new_callable=AsyncMock,
        return_value=FILE_LISTING,
    ):
        with patch(
            "mirage.core.dropbox.read.dropbox_download",
            new_callable=AsyncMock,
            return_value=(b"hi!", None),
        ) as download:
            data = await read(
                make_accessor(),
                PathSpec(
                    virtual="/dropbox/note.txt",
                    directory="/dropbox",
                    vfs_path=mount_key("/dropbox/note.txt", "/dropbox"),
                ),
                index,
            )
    assert data == b"hi!"
    assert download.await_args.args[1] == "/note.txt"


@pytest.mark.asyncio
async def test_a_ranged_read_asks_dropbox_for_the_range(index):
    with patch(
        "mirage.core.dropbox.readdir.list_folder",
        new_callable=AsyncMock,
        return_value=FILE_LISTING,
    ):
        with patch(
            "mirage.core.dropbox.read.dropbox_download",
            new_callable=AsyncMock,
            return_value=(b"i!", None),
        ) as download:
            data = await read(
                make_accessor(),
                PathSpec(
                    virtual="/note.txt", directory="/", vfs_path="note.txt"
                ),
                index,
                offset=1,
                size=2,
            )
    assert data == b"i!"
    assert download.await_args.args[2] == ByteWindow(1, 2)


@pytest.mark.asyncio
async def test_an_index_less_ranged_read_still_carries_the_range(index):
    # The ops factory's emulated truncate reads without an index, which
    # takes the other branch of read() and must range just the same.
    with patch(
        "mirage.core.dropbox.read.dropbox_download",
        new_callable=AsyncMock,
        return_value=(b"i!", None),
    ) as download:
        await read(
            make_accessor(),
            PathSpec(virtual="/note.txt", directory="/", vfs_path="note.txt"),
            offset=1,
            size=2,
        )
    assert download.await_args.args[2] == ByteWindow(1, 2)


@pytest.mark.asyncio
async def test_read_downloads_through_subfolder_root(index):
    with patch(
        "mirage.core.dropbox.readdir.list_folder",
        new_callable=AsyncMock,
        return_value=FILE_LISTING,
    ):
        with patch(
            "mirage.core.dropbox.read.dropbox_download",
            new_callable=AsyncMock,
            return_value=(b"hi", None),
        ) as download:
            data = await read(
                make_accessor("Team/data"),
                PathSpec(
                    virtual="/dropbox/note.txt",
                    directory="/dropbox",
                    vfs_path=mount_key("/dropbox/note.txt", "/dropbox"),
                ),
                index,
            )
    assert data == b"hi"
    assert download.await_args.args[1] == "/Team/data/note.txt"


@pytest.mark.asyncio
async def test_read_folder_raises_isadirectory(index):
    listing = [
        {
            ".tag": "folder",
            "id": "id:f",
            "name": "docs",
            "path_display": "/docs",
        }
    ]
    with patch(
        "mirage.core.dropbox.readdir.list_folder",
        new_callable=AsyncMock,
        return_value=listing,
    ):
        with pytest.raises(IsADirectoryError):
            await read(
                make_accessor(),
                PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
                index,
            )


@pytest.mark.asyncio
async def test_read_missing_raises_enoent(index):
    with patch(
        "mirage.core.dropbox.readdir.list_folder",
        new_callable=AsyncMock,
        return_value=[],
    ):
        with pytest.raises(FileNotFoundError):
            await read(
                make_accessor(),
                PathSpec(
                    vfs_path="missing.txt",
                    virtual="/missing.txt",
                    directory="/",
                ),
                index,
            )


DATA = b"0123456789"


def served_accessor(url: str) -> DropboxAccessor:
    config = DropboxConfig(
        client_id="c", client_secret="s", refresh_token="r", endpoint=url
    )
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
@pytest.mark.parametrize("indexed", [True, False], ids=["indexed", "bare"])
@pytest.mark.parametrize(
    "offset, size, expected",
    [(0, None, DATA), (2, 3, b"234")],
    ids=["full", "ranged"],
)
async def test_every_byte_read_records_the_content_hash(
    indexed, offset, size, expected
):
    # A ranged read is answered 206 and still carries Dropbox-API-Result,
    # so every read stamps the token stat answers, at no extra request.
    with serve(FakeDropbox(files={"/a.txt": DATA})) as dropbox:
        accessor = served_accessor(dropbox.url)
        args = (RAMIndexCacheStore(),) if indexed else ()
        scope = RecordingScope()
        try:
            data = await read(
                accessor,
                PathSpec(virtual="/a.txt", directory="/", vfs_path="a.txt"),
                *args,
                offset=offset,
                size=size,
            )
        finally:
            scope.close()
            await accessor.close()
    assert data == expected
    assert [(r.op, r.bytes, r.fingerprint) for r in scope.records] == [
        ("read", len(expected), content_hash(DATA))
    ]


@pytest.mark.asyncio
async def test_a_stream_records_the_content_hash():
    with serve(FakeDropbox(files={"/a.txt": DATA})) as dropbox:
        accessor = served_accessor(dropbox.url)
        scope = RecordingScope()
        try:
            chunks = [
                c
                async for c in stream(
                    accessor,
                    PathSpec(
                        virtual="/a.txt", directory="/", vfs_path="a.txt"
                    ),
                    RAMIndexCacheStore(),
                )
            ]
        finally:
            scope.close()
            await accessor.close()
    assert b"".join(chunks) == DATA
    assert [(r.op, r.bytes, r.fingerprint) for r in scope.records] == [
        ("read", len(DATA), content_hash(DATA))
    ]


@pytest.mark.asyncio
async def test_a_stream_with_no_recorder_bound_still_streams():
    # Outside a shell line (FUSE, a programmatic read) record_stream
    # answers None; the stamp and the byte count must then do nothing.
    with serve(FakeDropbox(files={"/a.txt": DATA})) as dropbox:
        accessor = served_accessor(dropbox.url)
        try:
            chunks = [
                c
                async for c in stream(
                    accessor,
                    PathSpec(
                        virtual="/a.txt", directory="/", vfs_path="a.txt"
                    ),
                    RAMIndexCacheStore(),
                )
            ]
        finally:
            await accessor.close()
    assert b"".join(chunks) == DATA


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "offset, size", [(0, None), (2, 3)], ids=["full", "ranged"]
)
async def test_a_read_stamps_the_download_hash_not_the_listing_rows(
    offset, size
):
    # The listing that resolved the entry may lag the bytes; the token
    # must describe the bytes, so it comes from the download's own
    # Dropbox-API-Result.
    fake = FakeDropbox(files={"/a.txt": DATA}, listed={"/a.txt": "stale"})
    with serve(fake) as dropbox:
        accessor = served_accessor(dropbox.url)
        scope = RecordingScope()
        try:
            await read(
                accessor,
                PathSpec(virtual="/a.txt", directory="/", vfs_path="a.txt"),
                RAMIndexCacheStore(),
                offset=offset,
                size=size,
            )
        finally:
            scope.close()
            await accessor.close()
    assert [r.fingerprint for r in scope.records] == [content_hash(DATA)]


@pytest.mark.asyncio
async def test_a_stream_stamps_the_download_hash_not_the_listing_rows():
    fake = FakeDropbox(files={"/a.txt": DATA}, listed={"/a.txt": "stale"})
    with serve(fake) as dropbox:
        accessor = served_accessor(dropbox.url)
        scope = RecordingScope()
        try:
            async for _ in stream(
                accessor,
                PathSpec(virtual="/a.txt", directory="/", vfs_path="a.txt"),
                RAMIndexCacheStore(),
            ):
                pass
        finally:
            scope.close()
            await accessor.close()
    assert [r.fingerprint for r in scope.records] == [content_hash(DATA)]


@pytest.mark.asyncio
async def test_an_index_less_read_of_a_missing_path_is_enoent():
    # The ops factory's emulated truncate reads with no index; the API's
    # 409 for a missing path must read as ENOENT, not a raw API error.
    with serve(FakeDropbox(files={})) as dropbox:
        accessor = served_accessor(dropbox.url)
        try:
            with pytest.raises(FileNotFoundError):
                await read(
                    accessor,
                    PathSpec(virtual="/nope", directory="/", vfs_path="nope"),
                )
        finally:
            await accessor.close()


@pytest.mark.asyncio
async def test_an_index_less_server_error_is_not_absence():
    with patch(
        "mirage.core.dropbox.read.dropbox_download",
        new_callable=AsyncMock,
        side_effect=DropboxApiError("boom", 500),
    ):
        with pytest.raises(DropboxApiError):
            await read(
                make_accessor(),
                PathSpec(virtual="/a.txt", directory="/", vfs_path="a.txt"),
            )
