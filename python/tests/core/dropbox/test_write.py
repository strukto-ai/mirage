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

import aiohttp
import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.client import DropboxTokenManager
from mirage.core.dropbox.create import create
from mirage.core.dropbox.write import write
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.vfs.dropbox.config import DropboxConfig


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(
        client_id="c",
        client_secret="s",
        refresh_token="r",
        root_path=root_path,
    )
    return DropboxAccessor(config, DropboxTokenManager(config))


def _file_metadata(**fields) -> dict:
    # Dropbox's upload reply: the stored file's FileMetadata.
    return {
        ".tag": "file",
        "name": "note.txt",
        "id": "id:abc",
        "path_display": "/note.txt",
        "server_modified": "2026-01-01T00:00:00Z",
        "size": 5,
        "content_hash": "h5",
        **fields,
    }


@pytest.mark.asyncio
async def test_write_uploads_through_subfolder_root():
    with patch(
        "mirage.core.dropbox.write.dropbox_upload", new_callable=AsyncMock
    ) as upload:
        await write(
            make_accessor("/Team/data"),
            PathSpec.from_str_path("/note.txt"),
            b"hi",
        )
    assert upload.await_args.args[1] == "/Team/data/note.txt"
    assert upload.await_args.args[2] == b"hi"


@pytest.mark.asyncio
async def test_create_uploads_empty_bytes():
    with patch(
        "mirage.core.dropbox.write.dropbox_upload", new_callable=AsyncMock
    ) as upload:
        await create(make_accessor(), PathSpec.from_str_path("/new.txt"))
    assert upload.await_args.args[1] == "/new.txt"
    assert upload.await_args.args[2] == b""


# (upload reply, expected (bytes, fingerprint)) for 5 written bytes. "h5"
# is a token no local hash produces.
_REPLY_ROWS = [
    (_file_metadata(), (5, "h5")),
    # The stored size is the reply's, not the bytes sent.
    (_file_metadata(size=9), (9, "h5")),
]
_REPLY_IDS = ["agrees", "stored-size-differs"]


async def _write_recorded(reply):
    order: list[tuple[str, int]] = []
    scope = RecordingScope()

    async def _spy(path):
        order.append(("invalidate", len(scope.records)))

    try:
        with (
            patch(
                "mirage.core.dropbox.write.dropbox_upload",
                new_callable=AsyncMock,
                return_value=reply,
            ),
            patch(
                "mirage.core.dropbox.write.invalidate_after_write", new=_spy
            ),
            patch(
                "mirage.core.dropbox.write.invalidate_ancestors",
                new_callable=AsyncMock,
            ),
        ):
            await write(
                make_accessor(), PathSpec.from_str_path("/note.txt"), b"hello"
            )
    finally:
        scope.close()
    rows = [
        (r.op, r.path, r.bytes, r.fingerprint, r.revision)
        for r in scope.records
    ]
    return rows, order


@pytest.mark.asyncio
async def test_a_write_whose_reply_fails_still_evicts_the_path():
    # Dropbox may have stored the bytes before the reply broke off, so the
    # cached copy is stale either way; nothing vouches for a write record.
    scope = RecordingScope()
    evicted: list[str] = []

    async def _spy(path):
        evicted.append(path.virtual)

    try:
        with (
            patch(
                "mirage.core.dropbox.write.dropbox_upload",
                new_callable=AsyncMock,
                side_effect=aiohttp.ClientPayloadError("reply cut off"),
            ),
            patch(
                "mirage.core.dropbox.write.invalidate_after_write", new=_spy
            ),
            patch(
                "mirage.core.dropbox.write.invalidate_ancestors",
                new_callable=AsyncMock,
            ),
            pytest.raises(aiohttp.ClientPayloadError),
        ):
            await write(
                make_accessor(), PathSpec.from_str_path("/note.txt"), b"hello"
            )
    finally:
        scope.close()
    assert evicted == ["/note.txt"]
    assert scope.records == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("reply", "expected"), _REPLY_ROWS, ids=_REPLY_IDS)
async def test_write_records_the_reply_token_and_stored_size(reply, expected):
    rows, order = await _write_recorded(reply)
    nbytes, token = expected
    assert rows == [("write", "/note.txt", nbytes, token, None)]
    # Recorded before the eviction, so the record exists when the cache
    # reacts to the write.
    assert order == [("invalidate", 1)]
