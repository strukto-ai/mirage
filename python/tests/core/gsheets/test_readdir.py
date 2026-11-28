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

from urllib.parse import parse_qs

import pytest

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gsheets import GSheetsVFS
from tests.fixtures.google_account import FILES
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


async def _listed_queries(google_account) -> list[str]:
    """The query of each listing asked since recording started."""
    return [
        parse_qs(r["query"])["q"][0]
        for r in await google_account.asked("GET", FILES)
    ]


def _mounted(google_account) -> Mounted:
    return Mounted(GSheetsVFS, _accessor(google_account), APP)


async def readdir(mounted: Mounted, path: PathSpec) -> list[str]:
    return await mounted.readdir(path)


async def stat(mounted: Mounted, path: PathSpec) -> FileStat:
    return await mounted.stat(path)


@pytest.mark.asyncio
async def test_readdir_root(google_account):
    await google_account.run.record_requests()
    result = await readdir(_mounted(google_account), _spec(APP))
    assert result == [f"{APP}/owned", f"{APP}/shared"]
    assert await google_account.log() == []


@pytest.mark.asyncio
async def test_readdir_owned(google_account):
    made = await _made(google_account, "My Sheet", "2026-04-01T00:00:00.000Z")
    result = await readdir(_mounted(google_account), _spec(f"{APP}/owned"))
    assert len(result) == 1
    assert made in result[0]


@pytest.mark.asyncio
async def test_readdir_file_path_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await readdir(
            _mounted(google_account), _spec(f"{APP}/owned/file{SUFFIX}")
        )


@pytest.mark.asyncio
async def test_readdir_invalid_path_raises(google_account):
    with pytest.raises(FileNotFoundError):
        await readdir(_mounted(google_account), _spec(f"{APP}/bogus"))


@pytest.mark.asyncio
async def test_readdir_owned_pushes_modified_range(google_account):
    await google_account.run.record_requests()
    await readdir(
        _mounted(google_account),
        _spec(f"{APP}/owned/2026-05-*", "2026-05-*"),
    )
    (q,) = await _listed_queries(google_account)
    assert "modifiedTime >= '2026-05-01T00:00:00Z'" in q
    assert "modifiedTime < '2026-06-01T00:00:00Z'" in q


@pytest.mark.asyncio
async def test_readdir_owned_filtered_does_not_cache(google_account):
    await _made(google_account, "MayDoc", "2026-05-15T00:00:00.000Z")
    await _made(google_account, "JanDoc", "2026-01-15T00:00:00.000Z")
    mounted = _mounted(google_account)
    await google_account.run.record_requests()
    await readdir(mounted, _spec(f"{APP}/owned/2026-05-*", "2026-05-*"))
    result = await readdir(mounted, _spec(f"{APP}/owned"))
    assert len(await _listed_queries(google_account)) == 2
    assert len(result) == 2


@pytest.mark.asyncio
async def test_readdir_owned_glob_matches_a_whole_listing(google_account):
    may = await _made(google_account, "MayDoc", "2026-05-15T00:00:00.000Z")
    await _made(google_account, "JanDoc", "2026-01-15T00:00:00.000Z")
    mounted = _mounted(google_account)
    await google_account.run.record_requests()
    await readdir(mounted, _spec(f"{APP}/owned"))
    matched = await readdir(
        mounted, _spec(f"{APP}/owned/2026-05-*", "2026-05-*")
    )
    # The whole corpus is already listed, so the glob is matched against
    # it rather than asked of Drive again.
    assert len(await _listed_queries(google_account)) == 1
    assert len(matched) == 1 and may in matched[0]


@pytest.mark.asyncio
async def test_readdir_owned_no_pattern_omits_range(google_account):
    await google_account.run.record_requests()
    await readdir(_mounted(google_account), _spec(f"{APP}/owned"))
    (q,) = await _listed_queries(google_account)
    assert "modifiedTime" not in q


@pytest.mark.asyncio
async def test_readdir_owned_non_date_pattern_omits_range(google_account):
    await google_account.run.record_requests()
    await readdir(
        _mounted(google_account), _spec(f"{APP}/owned/*foo*", "*foo*")
    )
    (q,) = await _listed_queries(google_account)
    assert "modifiedTime" not in q


@pytest.mark.asyncio
async def test_readdir_entry_size_none_source_size_in_extra(google_account):
    made = await _made(google_account, "My Sheet", "2026-04-01T00:00:00.000Z")
    await _answer_listing(google_account, **{made: {"size": "1234"}})
    mounted = _mounted(google_account)
    result = await readdir(mounted, _spec(f"{APP}/owned"))
    # Drive's source size never becomes the row's size: the rendered
    # JSON length is unknown until read.
    row = await mounted.stat(
        PathSpec.from_str_path(result[0], mount_key(result[0], APP))
    )
    assert row.size is None
    assert row.extra["source_size"] == 1234


@pytest.mark.asyncio
async def test_readdir_incomplete_search_is_not_cached_as_the_directory(
    google_account,
):
    """Drive reporting a corpus it skipped means the listing is short.

    Keeping it would pin the short listing until it expires, so a Shared
    Drive document stays invisible long after the cause clears: the next
    listing asks Drive again until one finishes.
    """
    await _made(google_account, "Doc", "2026-05-15T00:00:00.000Z")
    listing = await google_account.run.call(
        "GET", FILES, params={"q": f"mimeType = '{MIME}'"}
    )
    await google_account.run.answer_next(
        "GET", FILES, 200, {**listing, "incompleteSearch": True}, times=2
    )
    mounted = _mounted(google_account)
    owned = _spec(f"{APP}/owned")
    await google_account.run.record_requests()
    listed = await readdir(mounted, owned)
    assert len(listed) == 1
    await readdir(mounted, owned)
    assert len(await _listed_queries(google_account)) == 2
    await readdir(mounted, owned)
    await readdir(mounted, owned)
    assert len(await _listed_queries(google_account)) == 3
