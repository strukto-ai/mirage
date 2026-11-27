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

from mirage.context import session_context as caller
from mirage.core.gdrive.checksum import checksum
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.google_account import FILE

SCOPE = PathSpec(vfs_path="r.pdf", virtual="/r.pdf", directory="/")
DATA = b"report bytes"


def _row(file_id: str, resource_type: str) -> FileStat:
    return FileStat(
        name="r.pdf",
        type=FileType.FILE,
        extra={"file_id": file_id, "resource_type": resource_type},
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
    google_account, algorithm, field
):
    made = await google_account.upload("r.pdf", DATA)
    # Drive's digest in capitals, which the answer lowers.
    answered = await google_account.item(made)
    answered[field] = answered[field].upper()
    await google_account.run.answer_next("GET", FILE, 200, answered)
    await google_account.run.record_requests()
    scope = RecordingScope()
    try:
        got = await checksum(
            google_account.drive_accessor(),
            SCOPE,
            algorithm,
            _row(made, "gdrive/file"),
        )
    finally:
        scope.close()
    assert got == hashlib.new(algorithm, DATA).hexdigest()
    assert [name for name, _ in await google_account.log()] == ["get"]
    asked = (await google_account.run.params("GET", FILE))[0]["fields"]
    fields = asked.split(",")
    assert fields[0] == field
    assert {"md5Checksum", "headRevisionId"} <= set(fields)
    assert [
        (r.op, r.path, r.fingerprint, r.revision) for r in scope.records
    ] == [
        (
            "read",
            "/r.pdf",
            answered["md5Checksum"],
            answered["headRevisionId"],
        )
    ]


@pytest.mark.asyncio
async def test_a_native_file_or_another_algorithm_reads(google_account):
    made = await google_account.upload("r.pdf", DATA)
    accessor = google_account.drive_accessor()
    await google_account.run.record_requests()
    doc = _row(made, "gdrive/gdoc")
    assert await checksum(accessor, SCOPE, "md5", doc) is None
    binary = _row(made, "gdrive/file")
    assert await checksum(accessor, SCOPE, "sha512", binary) is None
    assert await google_account.log() == []


@pytest.mark.asyncio
async def test_a_pinned_revision_reads(google_account):
    made = await google_account.upload("r.pdf", DATA)
    accessor = google_account.drive_accessor()
    await google_account.run.record_requests()
    token = caller.bind_caller(
        caller.current_caller().changed({"revisions": {SCOPE.virtual: "r7"}})
    )
    try:
        row = _row(made, "gdrive/file")
        assert await checksum(accessor, SCOPE, "md5", row) is None
    finally:
        caller.reset_caller(token)
    assert await google_account.log() == []
