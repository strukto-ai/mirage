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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdrive.read import read
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig
from mirage.types import PathSpec


@pytest.fixture
def config():
    return GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


@pytest.fixture
def token_manager(config):
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return mgr


@pytest.fixture
def accessor(config, token_manager):
    return GDriveAccessor(config=config, token_manager=token_manager)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_gdoc(accessor, index):
    await index.put(
        "/My Doc.gdoc.json",
        IndexEntry(
            id="doc1",
            name="My Doc",
            resource_type="gdrive/gdoc",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="My Doc.gdoc.json",
        ))
    with patch(
            "mirage.core.gdocs.read.google_get",
            new_callable=AsyncMock,
            return_value={"documentId": "doc1"},
    ):
        result = await read(
            accessor,
            PathSpec(resource_path=("/My Doc.gdoc.json").strip("/"),
                     virtual="/My Doc.gdoc.json",
                     directory="/My Doc.gdoc.json"), index)
        assert b"doc1" in result


@pytest.mark.asyncio
async def test_read_gsheet(accessor, index):
    await index.put(
        "/My Sheet.gsheet.json",
        IndexEntry(
            id="sheet1",
            name="My Sheet",
            resource_type="gdrive/gsheet",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="My Sheet.gsheet.json",
        ))
    with patch(
            "mirage.core.gsheets.read.google_get",
            new_callable=AsyncMock,
            return_value={"spreadsheetId": "sheet1"},
    ):
        result = await read(
            accessor,
            PathSpec(resource_path=("/My Sheet.gsheet.json").strip("/"),
                     virtual="/My Sheet.gsheet.json",
                     directory="/My Sheet.gsheet.json"), index)
        assert b"sheet1" in result


@pytest.mark.asyncio
async def test_read_gslide(accessor, index):
    await index.put(
        "/My Slides.gslide.json",
        IndexEntry(
            id="slide1",
            name="My Slides",
            resource_type="gdrive/gslide",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="My Slides.gslide.json",
        ))
    with patch(
            "mirage.core.gslides.read.google_get",
            new_callable=AsyncMock,
            return_value={"presentationId": "slide1"},
    ):
        result = await read(
            accessor,
            PathSpec(resource_path=("/My Slides.gslide.json").strip("/"),
                     virtual="/My Slides.gslide.json",
                     directory="/My Slides.gslide.json"), index)
        assert b"slide1" in result


@pytest.mark.asyncio
async def test_read_regular(accessor, index):
    await index.put(
        "/photo.png",
        IndexEntry(
            id="img1",
            name="photo",
            resource_type="gdrive/file",
            remote_time="2026-04-01T00:00:00.000Z",
            vfs_name="photo.png",
        ))
    img_bytes = b"\x89PNG\r\n"
    with patch(
            "mirage.core.gdrive.read.download_file",
            new_callable=AsyncMock,
            return_value=img_bytes,
    ):
        result = await read(
            accessor,
            PathSpec(resource_path=("/photo.png").strip("/"),
                     virtual="/photo.png",
                     directory="/photo.png"), index)
        assert result == img_bytes
