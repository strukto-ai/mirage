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

from mirage.core.gdrive.set_attrs import set_attrs
from mirage.core.google.client import GoogleApiError
from mirage.types import FileStat, FileType, PathSpec
from tests.fixtures.google_account import FILE

MTIME = "2020-01-01T00:00:00+00:00"


def _row(file_id: str) -> FileStat:
    return FileStat(
        name="a.txt", type=FileType.FILE, extra={"file_id": file_id}
    )


@pytest.mark.asyncio
async def test_an_mtime_becomes_the_files_modified_time(google_account):
    made = await google_account.upload("a.txt", b"a")
    await google_account.run.record_requests()
    got = await set_attrs(
        google_account.drive_accessor(),
        PathSpec.from_str_path("/a.txt"),
        _row(made),
        uid=7,
        mtime=MTIME,
    )
    assert await google_account.run.bodies("PATCH", FILE) == [
        {"modifiedTime": "2020-01-01T00:00:00Z"}
    ]
    assert (await google_account.item(made))[
        "modifiedTime"
    ] == "2020-01-01T00:00:00.000Z"
    assert got == {"uid": 7}


@pytest.mark.asyncio
async def test_the_mount_root_keeps_its_attributes(google_account):
    await google_account.run.record_requests()
    got = await set_attrs(
        google_account.drive_accessor(),
        PathSpec.from_str_path("/"),
        None,
        uid=7,
        mtime=MTIME,
    )
    assert await google_account.log() == []
    assert got == {"uid": 7, "mtime": MTIME}


@pytest.mark.parametrize(
    ("status", "raised"),
    [(404, FileNotFoundError), (403, PermissionError), (500, GoogleApiError)],
)
@pytest.mark.asyncio
async def test_a_failed_patch_answers_by_its_status(
    google_account, status, raised
):
    made = await google_account.upload("a.txt", b"a")
    await google_account.refuse(
        "PATCH", FILE, status, f"File not found: {made}."
    )
    with pytest.raises(raised):
        await set_attrs(
            google_account.drive_accessor(),
            PathSpec.from_str_path("/a.txt"),
            _row(made),
            mtime=MTIME,
        )
