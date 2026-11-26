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

from mirage.core.box.checksum import checksum
from mirage.core.box.readdir import readdir
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from tests.fixtures.handed import entry_at

SCOPE = PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/a.txt")
FILE_ROUTE = "/2.0/files/:file_id"


async def _listed_then_changed(account, now: bytes | None = None):
    """``/a.txt`` and its entry as a listing gave it while it held
    "hello", after another client has since made it ``now``."""
    file_id = await account.put("a.txt", b"hello")
    entry = await entry_at(readdir, account.accessor(), SCOPE)
    if now is not None:
        await account.upload_version(file_id, now)
    return file_id, entry


@pytest.mark.asyncio
async def test_box_answers_its_live_sha1(account):
    # Box's own answer for the file now, in upper case.
    file_id, entry = await _listed_then_changed(account, b"world")
    live = await account.file_info(file_id)
    await account.run.answer_next(
        "GET", FILE_ROUTE, 200, {**live, "sha1": live["sha1"].upper()}
    )
    await account.run.record_requests()
    got = await checksum(account.accessor(), SCOPE, "sha1", entry)
    assert got == hashlib.sha1(b"world").hexdigest()
    assert await account.run.requests() == [f"GET /2.0/files/{file_id}"]


@pytest.mark.asyncio
@pytest.mark.parametrize("sha1", [None, ""])
async def test_box_without_a_sha1_reads(account, sha1):
    file_id, entry = await _listed_then_changed(account)
    live = await account.file_info(file_id)
    await account.run.answer_next(
        "GET", FILE_ROUTE, 200, {**live, "sha1": sha1}
    )
    assert await checksum(account.accessor(), SCOPE, "sha1", entry) is None


@pytest.mark.asyncio
async def test_box_keeps_no_md5(account):
    _, entry = await _listed_then_changed(account)
    await account.run.record_requests()
    assert await checksum(account.accessor(), SCOPE, "md5", entry) is None
    assert await account.run.requests() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "now,token",
    [(None, hashlib.sha1(b"hello").hexdigest()), (b"world", None)],
    ids=["as-listed", "changed-since"],
)
async def test_box_records_the_token_a_read_would(account, now, token):
    _, entry = await _listed_then_changed(account, now)
    scope = RecordingScope()
    try:
        await checksum(account.accessor(), SCOPE, "sha1", entry)
    finally:
        scope.close()
    assert [(r.op, r.path, r.fingerprint) for r in scope.records] == [
        ("read", "/a.txt", token)
    ]
