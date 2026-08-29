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
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.identity import live_identity
from mirage.core.sharepoint.resolve import _drive_cache, _site_cache
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"


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


@pytest.fixture(autouse=True)
def _reset_caches():
    _clear_caches()
    yield
    _clear_caches()


@pytest.mark.asyncio
async def test_identity_found_file_returns_ctag_fingerprint():
    _seed_caches()
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.docx"
    with aioresponses() as m:
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
    _seed_caches()
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/nope.txt"
    with aioresponses() as m:
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
    _seed_caches()
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/src"
    with aioresponses() as m:
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
async def test_identity_site_level_raises_eisdir_without_a_request():
    _site_cache["Engineering"] = _SITE_ID
    with pytest.raises(IsADirectoryError):
        await live_identity(_accessor(), _ps("/sp/Engineering"))


@pytest.mark.asyncio
async def test_identity_drive_level_raises_eisdir_without_a_request():
    _seed_caches()
    with pytest.raises(IsADirectoryError):
        await live_identity(_accessor(), _ps("/sp/Engineering/Documents"))


@pytest.mark.asyncio
async def test_identity_folder_spelled_with_a_trailing_slash_is_eisdir():
    # Graph is item-addressed off the slashless resource_path, so the
    # hint costs nothing: the folder facet on the answer is what refuses
    # it, the same as without the slash.
    _seed_caches()
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/src"
    with aioresponses() as m:
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
    _seed_caches()
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/nope"
    with aioresponses() as m:
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
