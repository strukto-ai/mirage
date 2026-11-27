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
from mirage.core.gsheets.stat import stat
from mirage.types import ContentType, FileType, PathSpec
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
async def test_stat_root(google_account):
    result = await stat(_accessor(google_account), _spec(APP))
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_owned_dir(google_account):
    result = await stat(_accessor(google_account), _spec(f"{APP}/owned"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "owned"


@pytest.mark.asyncio
async def test_stat_sheet_from_the_listing(google_account):
    stamp = "2026-04-01T00:00:00.000Z"
    made = await _made(google_account, "My Sheet", stamp)
    await _answer_listing(google_account, **{made: {"size": "1000"}})
    mounted = Mounted(GSheetsVFS, _accessor(google_account), APP)
    (target,) = await mounted.readdir("/owned")
    result = await mounted.stat(target.removeprefix(APP))
    assert result.name == f"2026-04-01_My_Sheet__{made}{SUFFIX}"
    assert result.content == ContentType.JSON
    assert result.modified == stamp
    assert result.fingerprint == stamp
    assert result.extra["doc_id"] == made
    assert result.extra["doc_name"] == "My Sheet"
    # rendered JSON length is unknown until read; the Drive source size
    # is surfaced via extra only
    assert result.size is None
    assert result.extra["source_size"] == 1000


@pytest.mark.asyncio
async def test_stat_cache_miss_fetches_metadata_by_id(google_account):
    made = await _made(google_account, "My Sheet", "2026-04-01T00:00:00.000Z")
    # A native file's source size, which the fake keeps none of.
    item = await google_account.item(made)
    await google_account.run.answer_next(
        "GET", FILE, 200, {**item, "size": "1234"}
    )
    target = f"{APP}/owned/2026-04-01_My_Sheet__{made}{SUFFIX}"
    await google_account.run.record_requests()
    result = await stat(_accessor(google_account), _spec(target))
    assert result.content == ContentType.JSON
    assert result.extra["doc_id"] == made
    assert result.size is None
    assert result.extra["source_size"] == 1234
    assert await google_account.log() == [("get", made)]


@pytest.mark.asyncio
async def test_stat_not_found_after_fallback(google_account):
    await _made(google_account, "My Sheet", "2026-04-01T00:00:00.000Z")
    with pytest.raises(FileNotFoundError):
        await stat(
            _accessor(google_account),
            _spec(f"{APP}/owned/nonexistent{SUFFIX}"),
        )
