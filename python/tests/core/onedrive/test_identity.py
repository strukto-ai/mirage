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

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.onedrive.identity import live_identity
from mirage.types import PathSpec

_FILE_URL = ("https://graph.microsoft.com/v1.0/me/drive"
             "/root:/Docs/report.docx")
_DIR_URL = "https://graph.microsoft.com/v1.0/me/drive/root:/Docs"


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


@pytest.mark.asyncio
async def test_identity_found_file_returns_ctag_fingerprint():
    with aioresponses() as m:
        m.get(_FILE_URL,
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
            _accessor(), PathSpec.from_str_path("/Docs/report.docx"))
    assert result.exists is True
    assert result.fingerprint == "ctag-abc"
    # Bounded per the identity contract: no $expand=versions scan, so
    # revision stays None until a bounded revision call is proven safe.
    assert result.revision is None


@pytest.mark.asyncio
async def test_identity_missing_reports_exists_false():
    with aioresponses() as m:
        m.get(_FILE_URL,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        result = await live_identity(
            _accessor(), PathSpec.from_str_path("/Docs/report.docx"))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


@pytest.mark.asyncio
async def test_identity_folder_raises_eisdir():
    with aioresponses() as m:
        m.get(_DIR_URL,
              payload={
                  "id": "01FOLDER",
                  "name": "Docs",
                  "folder": {
                      "childCount": 2
                  },
              })
        with pytest.raises(IsADirectoryError):
            await live_identity(_accessor(), PathSpec.from_str_path("/Docs"))


@pytest.mark.asyncio
async def test_identity_mount_root_raises_eisdir_without_a_request():
    with pytest.raises(IsADirectoryError):
        await live_identity(_accessor(), PathSpec.from_str_path("/"))


@pytest.mark.asyncio
async def test_identity_folder_spelled_with_a_trailing_slash_is_eisdir():
    # Graph is item-addressed off the slashless resource_path, so the
    # hint costs nothing: the folder facet on the answer is what refuses
    # it, the same as without the slash.
    with aioresponses() as m:
        m.get(_DIR_URL,
              payload={
                  "id": "01FOLDER",
                  "name": "Docs",
                  "folder": {
                      "childCount": 2
                  },
              })
        with pytest.raises(IsADirectoryError):
            await live_identity(_accessor(), PathSpec.from_str_path("/Docs/"))


@pytest.mark.asyncio
async def test_identity_absent_path_with_a_trailing_slash_reports_absent():
    with aioresponses() as m:
        m.get(_DIR_URL,
              status=404,
              payload={"error": {
                  "code": "itemNotFound",
                  "message": "no"
              }})
        result = await live_identity(_accessor(),
                                     PathSpec.from_str_path("/Docs/"))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None
