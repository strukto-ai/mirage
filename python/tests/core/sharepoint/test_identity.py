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

import re

import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.identity import live_identity
from mirage.core.sharepoint.resolve import _drive_cache, _site_cache
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_STALE_DRIVE_ID = "b!driveOLD"
_SITES_RE = re.compile(r".*/sites\?.*")
_DRIVES_RE = re.compile(r".*/sites/.*/drives.*")


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


def _ps(virtual: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(virtual, "/sp"),
                    virtual=virtual,
                    directory=virtual)


def _seed_caches():
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID


def _clear_caches():
    _site_cache.clear()
    _drive_cache.clear()


def _namespace(m: aioresponses,
               sites: list[dict] | None = None,
               drives: list[dict] | None = None) -> None:
    """Answer the site and drive listings the live resolve always makes.

    Args:
        m (aioresponses): the mock router.
        sites (list[dict] | None): the /sites payload rows.
        drives (list[dict] | None): the /drives payload rows.
    """
    site_rows = sites if sites is not None else [{
        "id": _SITE_ID,
        "displayName": "Engineering",
        "name": "eng",
    }]
    drive_rows = drives if drives is not None else [{
        "id": _DRIVE_ID,
        "name": "Documents",
    }]
    m.get(_SITES_RE, payload={"value": site_rows}, repeat=True)
    m.get(_DRIVES_RE, payload={"value": drive_rows}, repeat=True)


@pytest.fixture(autouse=True)
def _reset_caches():
    _clear_caches()
    yield
    _clear_caches()


@pytest.mark.asyncio
async def test_identity_found_file_returns_ctag_fingerprint():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.docx"
    with aioresponses() as m:
        _namespace(m)
        m.get(url,
              payload={
                  "id": "01ITEM",
                  "name": "report.docx",
                  "cTag": "ctag-abc",
                  "eTag": "etag-xyz",
                  "file": {
                      "mimeType": "application/vnd.openxml"
                  },
              })
        result = await live_identity(
            _accessor(), _ps("/sp/Engineering/Documents/report.docx"))
    assert result.exists is True
    assert result.fingerprint == "ctag-abc"
    assert result.revision is None


@pytest.mark.asyncio
async def test_identity_missing_reports_exists_false():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/nope.txt"
    with aioresponses() as m:
        _namespace(m)
        m.get(url,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        result = await live_identity(_accessor(),
                                     _ps("/sp/Engineering/Documents/nope.txt"))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


@pytest.mark.asyncio
async def test_identity_folder_raises_eisdir():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/src"
    with aioresponses() as m:
        _namespace(m)
        m.get(url,
              payload={
                  "id": "02FOLDER",
                  "name": "src",
                  "folder": {
                      "childCount": 2
                  },
              })
        with pytest.raises(IsADirectoryError):
            await live_identity(_accessor(),
                                _ps("/sp/Engineering/Documents/src"))


@pytest.mark.asyncio
async def test_identity_site_level_raises_eisdir_without_an_item_request():
    with aioresponses() as m:
        _namespace(m)
        with pytest.raises(IsADirectoryError):
            await live_identity(_accessor(), _ps("/sp/Engineering"))


@pytest.mark.asyncio
async def test_identity_drive_level_raises_eisdir_without_an_item_request():
    with aioresponses() as m:
        _namespace(m)
        with pytest.raises(IsADirectoryError):
            await live_identity(_accessor(), _ps("/sp/Engineering/Documents"))


@pytest.mark.asyncio
async def test_identity_missing_site_reports_exists_false():
    # Absence is a value the caller branches on, so which component of
    # the path went missing must not change the shape of the answer.
    with aioresponses() as m:
        _namespace(m, sites=[])
        result = await live_identity(_accessor(),
                                     _ps("/sp/Gone/Documents/report.docx"))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


@pytest.mark.asyncio
async def test_identity_missing_drive_reports_exists_false():
    with aioresponses() as m:
        _namespace(m, drives=[])
        result = await live_identity(_accessor(),
                                     _ps("/sp/Engineering/Gone/report.docx"))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


@pytest.mark.asyncio
async def test_identity_ignores_a_stale_drive_id_after_a_recreate():
    # The memo is what freshness has to defeat here: the drive that
    # held this name was deleted and recreated, so the remembered id
    # names a drive that is gone. Reading it back would GET the old
    # drive and report exists=False for a file that is there.
    _seed_caches()
    _drive_cache[(_SITE_ID, "Documents")] = _STALE_DRIVE_ID
    stale = f"{_BASE}/drives/{_STALE_DRIVE_ID}/root:/report.docx"
    live = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.docx"
    with aioresponses() as m:
        _namespace(m)
        m.get(stale,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        m.get(live,
              payload={
                  "id": "01ITEM",
                  "name": "report.docx",
                  "cTag": "ctag-new",
                  "file": {
                      "mimeType": "application/vnd.openxml"
                  },
              })
        result = await live_identity(
            _accessor(), _ps("/sp/Engineering/Documents/report.docx"))
    assert result.exists is True
    assert result.fingerprint == "ctag-new"
    assert _drive_cache[(_SITE_ID, "Documents")] == _DRIVE_ID


@pytest.mark.asyncio
async def test_identity_reports_a_site_that_vanished_from_the_listing():
    # A relist that repopulates the memo is not enough on its own: the
    # entry for a name that is gone survives the merge, so the answer
    # has to come from the listing rather than from the memo.
    _seed_caches()
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.docx"
    with aioresponses() as m:
        _namespace(m, sites=[])
        # Answered so a memo-served resolve would report the file as
        # present: only reading the live listing gets this right.
        m.get(url,
              payload={
                  "id": "01ITEM",
                  "name": "report.docx",
                  "cTag": "ctag-abc",
                  "file": {
                      "mimeType": "application/vnd.openxml"
                  },
              })
        result = await live_identity(
            _accessor(), _ps("/sp/Engineering/Documents/report.docx"))
    assert result.exists is False


@pytest.mark.asyncio
async def test_identity_folder_spelled_with_a_trailing_slash_is_eisdir():
    # Graph is item-addressed off the slashless resource_path, so the
    # hint costs nothing: the folder facet on the answer is what refuses
    # it, the same as without the slash.
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/src"
    with aioresponses() as m:
        _namespace(m)
        m.get(url,
              payload={
                  "id": "02FOLDER",
                  "name": "src",
                  "folder": {
                      "childCount": 2
                  },
              })
        with pytest.raises(IsADirectoryError):
            await live_identity(_accessor(),
                                _ps("/sp/Engineering/Documents/src/"))


@pytest.mark.asyncio
async def test_identity_absent_path_with_a_trailing_slash_reports_absent():
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/nope"
    with aioresponses() as m:
        _namespace(m)
        m.get(url,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        result = await live_identity(_accessor(),
                                     _ps("/sp/Engineering/Documents/nope/"))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None
