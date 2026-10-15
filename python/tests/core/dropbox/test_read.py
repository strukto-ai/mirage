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
from mirage.cache.context import capture_read, push_write_context
from mirage.cache.types import WriteContext
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.read import read, read_stream
from mirage.core.dropbox.readdir import readdir
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.ranges import ByteWindow
from mirage.vfs.dropbox.config import DropboxConfig
from tests.fixtures.dropbox_api import FakeDropbox, content_hash, serve
from tests.fixtures.handed import call, entry_at


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(
        client_id="c",
        client_secret="s",
        refresh_token="r",
        root_path=root_path,
    )
    return DropboxAccessor(config, DropboxTokenManager(config))


NOTE = FileStat(name="note.txt", type=FileType.FILE)

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
async def test_read_strips_mount_prefix():
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
            data = await call(
                read,
                readdir,
                make_accessor(),
                PathSpec(
                    virtual="/dropbox/note.txt",
                    directory="/dropbox",
                    vfs_path=mount_key("/dropbox/note.txt", "/dropbox"),
                ),
            )
    assert data == b"hi!"
    assert download.await_args.args[1] == "/note.txt"


@pytest.mark.asyncio
async def test_a_ranged_read_asks_dropbox_for_the_range():
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
            data = await call(
                read,
                readdir,
                make_accessor(),
                PathSpec(
                    virtual="/note.txt", directory="/", vfs_path="note.txt"
                ),
                offset=1,
                size=2,
            )
    assert data == b"i!"
    assert download.await_args.args[2] == ByteWindow(1, 2)


@pytest.mark.asyncio
async def test_a_ranged_read_of_a_handed_row_carries_the_range():
    # Dropbox downloads by path: the row only says a file is there.
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
            entry=NOTE,
        )
    assert download.await_args.args[2] == ByteWindow(1, 2)


@pytest.mark.asyncio
async def test_read_downloads_through_subfolder_root():
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
            data = await call(
                read,
                readdir,
                make_accessor("Team/data"),
                PathSpec(
                    virtual="/dropbox/note.txt",
                    directory="/dropbox",
                    vfs_path=mount_key("/dropbox/note.txt", "/dropbox"),
                ),
            )
    assert data == b"hi"
    assert download.await_args.args[1] == "/Team/data/note.txt"


@pytest.mark.asyncio
async def test_read_folder_raises_isadirectory():
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
            await call(
                read,
                readdir,
                make_accessor(),
                PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
            )


@pytest.mark.asyncio
async def test_read_missing_raises_enoent():
    with patch(
        "mirage.core.dropbox.readdir.list_folder",
        new_callable=AsyncMock,
        return_value=[],
    ):
        with pytest.raises(FileNotFoundError):
            await call(
                read,
                readdir,
                make_accessor(),
                PathSpec(
                    vfs_path="missing.txt",
                    virtual="/missing.txt",
                    directory="/",
                ),
            )


DATA = b"0123456789"
# A listing that lags the bytes: a read's token must come from its own
# download, never from the row that resolved the entry.
LAGGING = {"/a.txt": "stale"}
A = PathSpec(virtual="/a.txt", directory="/", vfs_path="a.txt")


def served_accessor(url: str) -> DropboxAccessor:
    config = DropboxConfig(
        client_id="c", client_secret="s", refresh_token="r", endpoint=url
    )
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "offset, size, expected",
    [(0, None, DATA), (2, 3, b"234")],
    ids=["full", "ranged"],
)
async def test_every_byte_read_records_the_content_hash(
    offset, size, expected
):
    # A ranged read is answered 206 and still carries Dropbox-API-Result.
    with serve(FakeDropbox(files={"/a.txt": DATA}, listed=LAGGING)) as fake:
        accessor = served_accessor(fake.url)
        scope = RecordingScope()
        try:
            data = await call(
                read, readdir, accessor, A, offset=offset, size=size
            )
        finally:
            scope.close()
            await accessor.close()
    assert data == expected
    assert [(r.op, r.bytes, r.fingerprint) for r in scope.records] == [
        ("read", len(expected), content_hash(DATA))
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("recorded", [True, False], ids=["line", "bare"])
async def test_a_stream_records_the_content_hash(recorded):
    # Outside a shell line (FUSE, a programmatic read) there is no
    # recorder, and the stream must still stream.
    with serve(FakeDropbox(files={"/a.txt": DATA}, listed=LAGGING)) as fake:
        accessor = served_accessor(fake.url)
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
            ("read", len(DATA), content_hash(DATA))
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
    status, summary, raised
):
    # A miss says the listed file is no longer there, which the mount reads
    # as a stale row and lists again; anything else is a failure.
    with patch(
        "mirage.core.dropbox.read.dropbox_download",
        new_callable=AsyncMock,
        side_effect=DropboxApiError("refused", status, summary),
    ):
        with pytest.raises(raised):
            await read(make_accessor(), A, entry=NOTE)


async def _nothing(_path: PathSpec) -> str | None:
    return None


async def _none_all(paths: list[PathSpec]) -> list[str | None]:
    return [None] * len(paths)


async def _ignore(*_args: PathSpec | str) -> None:
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "conditional, offset, size, published",
    [
        (True, 0, None, [content_hash(DATA)]),
        (True, 2, 3, []),
        (False, 0, None, []),
    ],
    ids=["whole", "ranged", "unconditional"],
)
async def test_a_whole_read_publishes_its_token_on_a_conditional_mount(
    conditional, offset, size, published
):
    context = WriteContext(
        vfs="dropbox",
        conditions=frozenset({"put", "copy", "delete"}),
        read_version=_nothing,
        read_versions=_none_all,
        drop=_ignore,
        keep=_ignore,
    )
    prev = push_write_context(context if conditional else None)
    with serve(FakeDropbox(files={"/a.txt": DATA})) as fake:
        accessor = served_accessor(fake.url)
        try:
            _, tokens = await capture_read(
                A.virtual,
                lambda: call(
                    read, readdir, accessor, A, offset=offset, size=size
                ),
            )
        finally:
            push_write_context(prev)
            await accessor.close()
    assert tokens == published
