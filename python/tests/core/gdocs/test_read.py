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

import json
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdocs._client import TokenManager
from mirage.core.gdocs.read import read, read_doc
from mirage.resource.gdocs.config import GDocsConfig
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def token_manager():
    config = GDocsConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return mgr


@pytest.fixture
def accessor(token_manager):
    return GDocsAccessor(config=None, token_manager=token_manager)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_doc(token_manager):
    doc_json = {
        "documentId": "abc123",
        "title": "Test Doc",
        "body": {
            "content": []
        },
    }
    with patch(
            "mirage.core.gdocs.read.google_get",
            new_callable=AsyncMock,
            return_value=doc_json,
    ):
        result = await read_doc(token_manager, "abc123")
        parsed = json.loads(result)
        assert parsed["documentId"] == "abc123"
        assert parsed["title"] == "Test Doc"


@pytest.mark.asyncio
async def test_read_via_index(accessor, index):
    await index.set_dir("/gdocs/owned", [
        ("2026-04-01_My_Doc__doc1.gdoc.json",
         IndexEntry(id="abc123",
                    name="Test Doc",
                    resource_type="gdocs/file",
                    vfs_name="2026-04-01_My_Doc__doc1.gdoc.json")),
    ])
    doc_json = {
        "documentId": "abc123",
        "title": "Test Doc",
        "body": {
            "content": []
        },
    }
    with patch(
            "mirage.core.gdocs.read.google_get",
            new_callable=AsyncMock,
            return_value=doc_json,
    ):
        result = await read(
            accessor,
            PathSpec(
                resource_path=mount_key(
                    "/gdocs/owned/2026-04-01_My_Doc__doc1.gdoc.json",
                    "/gdocs"),
                virtual="/gdocs/owned/2026-04-01_My_Doc__doc1.gdoc.json",
                directory="/gdocs/owned/2026-04-01_My_Doc__doc1.gdoc.json"),
            index)
        parsed = json.loads(result)
        assert parsed["documentId"] == "abc123"


@pytest.mark.asyncio
async def test_read_no_index(accessor):
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(resource_path=mount_key(
                "/gdocs/owned/nonexistent.gdoc.json", "/gdocs"),
                     virtual="/gdocs/owned/nonexistent.gdoc.json",
                     directory="/gdocs/owned/nonexistent.gdoc.json"), None)


@pytest.mark.asyncio
async def test_read_auto_bootstraps_from_empty_index(accessor, index):
    files = [{
        "id": "doc1",
        "name": "Notes",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [{
            "me": True
        }],
    }]
    with (
            patch(
                "mirage.core.gdocs.readdir.list_all_files",
                new_callable=AsyncMock,
                return_value=files,
            ),
            patch(
                "mirage.core.gdocs.read.read_doc",
                new_callable=AsyncMock,
                return_value=b'{"documentId":"doc1"}',
            ),
    ):
        path = PathSpec(
            resource_path=mount_key(
                "/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json", "/gdocs"),
            virtual="/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json",
            directory="/gdocs/owned/2026-04-01_Notes__doc1.gdoc.json",
        )
        result = await read(accessor, path, index)
        assert b"doc1" in result


@pytest.mark.asyncio
async def test_read_missing_file_raises_after_recursion(accessor, index):
    with (
            patch(
                "mirage.core.gdocs.readdir.list_all_files",
                new_callable=AsyncMock,
                return_value=[],
            ),
            patch(
                "mirage.core.gdocs.read.read_doc",
                new_callable=AsyncMock,
                side_effect=AssertionError("should not call read_doc"),
            ),
    ):
        path = PathSpec(
            resource_path=mount_key("/gdocs/owned/Missing__xyz.gdoc.json",
                                    "/gdocs"),
            virtual="/gdocs/owned/Missing__xyz.gdoc.json",
            directory="/gdocs/owned/Missing__xyz.gdoc.json",
        )
        with pytest.raises(FileNotFoundError):
            await read(accessor, path, index)
