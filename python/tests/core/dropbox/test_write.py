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


def _file_metadata() -> dict:
    # Dropbox's upload reply: the stored file's FileMetadata.
    return {
        ".tag": "file",
        "name": "note.txt",
        "id": "id:abc",
        "path_display": "/note.txt",
        "server_modified": "2026-01-01T00:00:00Z",
        "size": 5,
        "content_hash": "h5",
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


async def _write_recorded(reply):
    scope = RecordingScope()

    try:
        with (
            patch(
                "mirage.core.dropbox.write.dropbox_upload",
                new_callable=AsyncMock,
                return_value=reply,
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
    return rows


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reply", "token"),
    [(_file_metadata(), "h5"), (None, None)],
    ids=["agrees", "empty-reply"],
)
async def test_write_records_the_reply_token(reply, token):
    # "h5" is a token no local hash produces.
    rows = await _write_recorded(reply)
    assert rows == [("write", "/note.txt", 5, token, None)]
