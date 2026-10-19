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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.checksum import checksum
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.observe.context import (
    RecordingScope,
    push_revisions,
    reset_revisions,
)
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.gdrive_api import StubDrive, install_drive

SCOPE = PathSpec(vfs_path="r.pdf", virtual="/r.pdf", directory="/")


@pytest.fixture
def accessor():
    config = GoogleConfig(
        client_id="id", client_secret="secret", refresh_token="refresh"
    )
    manager = TokenManager(config)
    manager._access_token = "fake-token"
    manager._expires_at = 9999999999
    return GDriveAccessor(config=config, token_manager=manager)


def _row(resource_type: str) -> FileStat:
    return FileStat(
        name="r.pdf",
        type=FileType.FILE,
        extra={"file_id": "f1", "resource_type": resource_type},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "algorithm,field",
    [
        ("md5", "md5Checksum"),
        ("sha1", "sha1Checksum"),
        ("sha256", "sha256Checksum"),
    ],
)
async def test_drive_answers_the_digest_it_keeps(
    accessor, monkeypatch, algorithm, field
):
    reply = {"md5Checksum": "m5", "headRevisionId": "h1", field: "ABC123"}
    get = AsyncMock(return_value=reply)
    install_drive(monkeypatch, StubDrive(get_file=get))
    scope = RecordingScope()
    try:
        got = await checksum(accessor, SCOPE, algorithm, _row("gdrive/file"))
    finally:
        scope.close()
    assert got == "abc123"
    file_id, asked = get.await_args.args
    assert file_id == "f1"
    fields = asked.split(",")
    assert fields[0] == field
    assert {"md5Checksum", "headRevisionId"} <= set(fields)
    assert [
        (r.op, r.path, r.fingerprint, r.revision) for r in scope.records
    ] == [("read", "/r.pdf", reply["md5Checksum"], "h1")]


@pytest.mark.asyncio
async def test_a_native_file_or_another_algorithm_reads(accessor, monkeypatch):
    get = AsyncMock()
    install_drive(monkeypatch, StubDrive(get_file=get))
    doc = _row("gdrive/gdoc")
    assert await checksum(accessor, SCOPE, "md5", doc) is None
    binary = _row("gdrive/file")
    assert await checksum(accessor, SCOPE, "sha512", binary) is None
    get.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_pinned_revision_reads(accessor, monkeypatch):
    get = AsyncMock()
    install_drive(monkeypatch, StubDrive(get_file=get))
    token = push_revisions({SCOPE.virtual: "r7"})
    try:
        row = _row("gdrive/file")
        assert await checksum(accessor, SCOPE, "md5", row) is None
    finally:
        reset_revisions(token)
    get.assert_not_awaited()
