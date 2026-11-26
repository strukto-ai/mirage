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
from unittest.mock import AsyncMock

import pytest

from mirage.cache.context import write_condition
from mirage.cache.types import (
    ABSENT_WRITE,
    MatchWrite,
    ReplaceRequest,
    WriteContext,
)
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.core.dropbox.create import create
from mirage.core.dropbox.write import replace, write
from mirage.errors.types import OperationNotSupportedError, StaleWriteError
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec

UPLOAD_ROUTE = "/2/files/upload"
METADATA_ROUTE = "/2/files/get_metadata"


@pytest.mark.asyncio
async def test_create_only_write_refuses_without_native_support(account):
    path = PathSpec.from_str_path("/new.txt")
    await account.run.record_requests()
    with pytest.raises(OperationNotSupportedError):
        await replace(
            account.accessor(), ReplaceRequest(path, b"ours", ABSENT_WRITE)
        )
    assert await account.run.bodies("POST", UPLOAD_ROUTE) == []
    assert await account.names() == []


@pytest.mark.asyncio
async def test_explicit_replacement_uses_its_condition_after_preparing_stream(
    account,
):
    listed = await account.put("/note.txt", b"hello")
    path = PathSpec.from_str_path("/note.txt")
    context = WriteContext(
        vfs="dropbox",
        conditions=frozenset({"put"}),
        read_version=AsyncMock(return_value="cached"),
        read_versions=AsyncMock(return_value=["cached"]),
        drop=AsyncMock(),
        keep=AsyncMock(),
    )

    async def body():
        assert await write_condition(path, "put") == MatchWrite("cached")
        yield b"ours"

    token = bind_caller(current_caller().changed({"write_context": context}))
    try:
        await replace(
            account.accessor(),
            ReplaceRequest(path, body(), MatchWrite(listed["content_hash"])),
        )
        assert await write_condition(path, "put") == MatchWrite("cached")
    finally:
        reset_caller(token)
    assert await account.read("/note.txt") == b"ours"


@pytest.mark.asyncio
async def test_a_replacement_names_the_rev_it_checked(account):
    # The path's spelling and the check both read the metadata Dropbox gave
    # just before another client's upload landed. The upload names the rev
    # that answer gave, so Dropbox refuses it and keeps the newer bytes.
    before = await account.put("/note.txt", b"hello")
    await account.put("/note.txt", b"later")
    await account.run.answer_next("POST", METADATA_ROUTE, 200, before, times=2)
    path = PathSpec.from_str_path("/note.txt")
    await account.run.record_requests("dropbox-api-arg")
    with pytest.raises(StaleWriteError):
        await replace(
            account.accessor(),
            ReplaceRequest(path, b"ours", MatchWrite(before["content_hash"])),
        )
    (sent,) = await account.run.headers("POST", UPLOAD_ROUTE)
    assert json.loads(sent["dropbox-api-arg"])["mode"] == {
        ".tag": "update",
        "update": before["rev"],
    }
    assert await account.read("/note.txt") == b"later"


@pytest.mark.asyncio
async def test_rejected_replacement_closes_started_source(account):
    closed = []
    path = PathSpec.from_str_path("/note.txt")

    async def body():
        try:
            yield b"head"
            yield b"tail"
        finally:
            closed.append(True)

    source = body()
    assert await anext(source) == b"head"
    with pytest.raises(OperationNotSupportedError):
        await replace(
            account.accessor(), ReplaceRequest(path, source, ABSENT_WRITE)
        )
    assert closed == [True]


@pytest.mark.asyncio
async def test_write_uploads_through_subfolder_root(account):
    await account.mkdir("/Team/data")
    await write(
        account.accessor("/Team/data"),
        PathSpec.from_str_path("/note.txt"),
        b"hi",
    )
    assert await account.read("/Team/data/note.txt") == b"hi"


@pytest.mark.asyncio
async def test_write_of_a_path_past_ascii(account):
    # Dropbox-API-Arg is a header, so a name past ASCII travels escaped.
    await write(account.accessor(), PathSpec.from_str_path("/你好.txt"), b"hi")
    assert await account.names() == ["你好.txt"]
    assert await account.read("/你好.txt") == b"hi"


@pytest.mark.asyncio
async def test_create_uploads_empty_bytes(account):
    await create(account.accessor(), PathSpec.from_str_path("/new.txt"))
    assert await account.read("/new.txt") == b""


@pytest.mark.asyncio
@pytest.mark.parametrize("token", ["h5", None], ids=["agrees", "empty-reply"])
async def test_write_records_the_reply_token(account, token):
    # Dropbox's own upload reply with its content_hash replaced by "h5", a
    # token no local hash produces; or a reply with no body.
    reply = await account.put("/other.txt", b"hello")
    body = None if token is None else {**reply, "content_hash": token}
    plan = {
        "method": "POST",
        "route": UPLOAD_ROUTE,
        "status": 200,
        "body": body,
    }
    await account.run.call("POST", "/_kit/faults", json={"plans": [plan]})
    scope = RecordingScope()
    try:
        await write(
            account.accessor(), PathSpec.from_str_path("/note.txt"), b"hello"
        )
    finally:
        scope.close()
    rows = [
        (r.op, r.path, r.bytes, r.fingerprint, r.revision)
        for r in scope.records
    ]
    assert rows == [("write", "/note.txt", 5, token, None)]
