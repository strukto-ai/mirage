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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.core.gsheets.read import read
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gsheets import GSheetsVFS
from tests.fixtures.google_account import FILE, FILES
from tests.fixtures.mounted import Mounted

APP = "/gsheets"
MIME = "application/vnd.google-apps.spreadsheet"
SUFFIX = ".gsheet.json"


def _accessor(google_account, clock=None) -> GSheetsAccessor:
    manager = google_account.token_manager(clock)
    return GSheetsAccessor(config=manager.config, token_manager=manager)


def _spec(virtual: str, pattern: str | None = None) -> PathSpec:
    directory = virtual.rsplit("/", 1)[0] if pattern else virtual
    return PathSpec(
        vfs_path=mount_key(virtual, APP),
        virtual=virtual,
        directory=directory,
        pattern=pattern,
    )


async def _made(google_account, name: str, stamp: str) -> str:
    """Make a file of the app named ``name``, stamped ``stamp``, and
    answer its id.

    Args:
        google_account (GoogleAccount): the account.
        name (str): its title.
        stamp (str): its modified time.
    """
    made = await google_account.create(name, MIME)
    await google_account.patch(made, modifiedTime=stamp)
    return made


async def _answer_listing(google_account, **fields_by_id) -> None:
    """Answer the next listing with the fake's own listing of the app's
    files, each file named in ``fields_by_id`` with those fields set: what
    the fake keeps no model of, as another owner or a native file's size.

    Args:
        google_account (GoogleAccount): the account.
        **fields_by_id: file id to the fields its row carries.
    """
    listing = await google_account.run.call(
        "GET", FILES, params={"q": f"mimeType = '{MIME}'"}
    )
    files = [
        {**row, **fields_by_id.get(row["id"], {})} for row in listing["files"]
    ]
    await google_account.run.answer_next(
        "GET", FILES, 200, {**listing, "files": files}
    )


@pytest.mark.asyncio
async def test_a_read_no_listing_named_resolves_by_id(google_account):
    made = await _made(google_account, "Notes", "2026-04-01T00:00:00.000Z")
    path = _spec(f"{APP}/owned/2026-04-01_Notes__{made}{SUFFIX}")
    await google_account.run.record_requests()
    result = await read(_accessor(google_account), path)
    assert made.encode() in result
    assert [name for name, _ in await google_account.log()] == [
        "get",
        "GET /v4/spreadsheets/:id",
    ]


@pytest.mark.asyncio
async def test_read_missing_file_raises_by_id(google_account):
    await google_account.run.record_requests()
    path = _spec(f"{APP}/owned/Missing__xyz{SUFFIX}")
    with pytest.raises(FileNotFoundError):
        await read(_accessor(google_account), path)
    assert [name for name, _ in await google_account.log()] == ["get"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stamp", "token"),
    [("2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"), ("", None)],
)
async def test_read_records_the_token_stat_reports(
    google_account, stamp, token
):
    # read: fresh compares this record with stat's fingerprint, so both take
    # the file's modified stamp, and a file without one stamps nothing.
    made = await _made(google_account, "My Sheet", "2026-04-01T00:00:00.000Z")
    if not stamp:
        # A file Drive gives no modified time: its own item without one,
        # on the listing and on the lookup.
        await _answer_listing(google_account, **{made: {"modifiedTime": ""}})
        item = await google_account.item(made)
        await google_account.run.answer_next(
            "GET", FILE, 200, {**item, "modifiedTime": ""}, times=2
        )
    accessor = _accessor(google_account)
    mounted = Mounted(GSheetsVFS, accessor, APP)
    scope = RecordingScope()
    try:
        (target,) = await mounted.readdir(_spec(f"{APP}/owned"))
        data = await read(accessor, _spec(target))
        info = await mounted.stat(_spec(target))
    finally:
        scope.close()

    assert [
        (r.op, r.path, r.source, r.bytes, r.fingerprint) for r in scope.records
    ] == [("read", target, "gsheets", len(data), token)]
    assert info.fingerprint == token
