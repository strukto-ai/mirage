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

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.s3.readdir import readdir
from mirage.core.s3.stat import stat
from mirage.resource.s3 import S3Config
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def s3_config():
    return S3Config(bucket="test-bucket", region="us-east-1")


@pytest.fixture
def s3_accessor(s3_config):
    return S3Accessor(s3_config)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


def _mock_client_ctx(mock_client):
    mock_ctx = AsyncMock()
    mock_ctx.__aenter__.return_value = mock_client
    return mock_ctx


class TestStatDirectoryFallback:

    @pytest.mark.asyncio
    async def test_stat_file_returns_filestat(self, s3_accessor):
        with patch("mirage.core.s3.stat.async_session") as mock_session:
            mock_client = AsyncMock()
            mock_client.head_object.return_value = {
                "ContentLength": 1024,
                "LastModified": datetime(2026, 1, 1, tzinfo=timezone.utc),
                "ETag": '"abc123"',
            }
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client)

            path = PathSpec(resource_path=mount_key("/s3/data/file.txt",
                                                    "/s3"),
                            virtual="/s3/data/file.txt",
                            directory="/s3/data/")
            result = await stat(s3_accessor, path)
            assert result.name == "file.txt"
            assert result.size == 1024
            assert result.type == FileType.TEXT

    @pytest.mark.asyncio
    async def test_stat_directory_prefix_fallback(self, s3_accessor):
        with patch("mirage.core.s3.stat.async_session") as mock_session:
            mock_client = AsyncMock()
            err = Exception("not found")
            err.response = {"Error": {"Code": "404"}}
            mock_client.head_object.side_effect = err
            mock_client.list_objects_v2.return_value = {
                "CommonPrefixes": [{
                    "Prefix": "data/subdir/"
                }],
            }
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client)

            path = PathSpec(resource_path=mount_key("/s3/data", "/s3"),
                            virtual="/s3/data",
                            directory="/s3/")
            result = await stat(s3_accessor, path)
            assert result.name == "data"
            assert result.type == FileType.DIRECTORY

    @pytest.mark.asyncio
    async def test_stat_directory_prefix_with_contents(self, s3_accessor):
        with patch("mirage.core.s3.stat.async_session") as mock_session:
            mock_client = AsyncMock()
            err = Exception("not found")
            err.response = {"Error": {"Code": "NoSuchKey"}}
            mock_client.head_object.side_effect = err
            mock_client.list_objects_v2.return_value = {
                "Contents": [{
                    "Key": "data/file.txt"
                }],
            }
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client)

            path = PathSpec(resource_path=mount_key("/s3/data", "/s3"),
                            virtual="/s3/data",
                            directory="/s3/")
            result = await stat(s3_accessor, path)
            assert result.name == "data"
            assert result.type == FileType.DIRECTORY

    @pytest.mark.asyncio
    async def test_stat_nonexistent_raises(self, s3_accessor):
        with patch("mirage.core.s3.stat.async_session") as mock_session:
            mock_client = AsyncMock()
            err = Exception("not found")
            err.response = {"Error": {"Code": "404"}}
            mock_client.head_object.side_effect = err
            mock_client.list_objects_v2.return_value = {}
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client)

            path = PathSpec(resource_path=mount_key("/s3/nope", "/s3"),
                            virtual="/s3/nope",
                            directory="/s3/")
            with pytest.raises(FileNotFoundError):
                await stat(s3_accessor, path)

    @pytest.mark.asyncio
    async def test_stat_root_returns_directory(self, s3_accessor):
        path = PathSpec(resource_path=mount_key("/s3/", "/s3"),
                        virtual="/s3/",
                        directory="/s3/")
        result = await stat(s3_accessor, path)
        assert result.name == "/"
        assert result.type == FileType.DIRECTORY


class TestStatIndexCache:

    @pytest.mark.asyncio
    async def test_stat_uses_index_for_folder(self, s3_accessor, index):
        await index.put(
            "/s3/data",
            IndexEntry(id="/data", name="data", resource_type="folder"))

        path = PathSpec(resource_path=mount_key("/s3/data", "/s3"),
                        virtual="/s3/data",
                        directory="/s3/")
        result = await stat(s3_accessor, path, index)
        assert result.name == "data"
        assert result.type == FileType.DIRECTORY

    @pytest.mark.asyncio
    async def test_stat_uses_index_for_file(self, s3_accessor, index):
        await index.put(
            "/s3/data/file.txt",
            IndexEntry(id="/data/file.txt",
                       name="file.txt",
                       resource_type="file",
                       size=2048))

        path = PathSpec(resource_path=mount_key("/s3/data/file.txt", "/s3"),
                        virtual="/s3/data/file.txt",
                        directory="/s3/data/")
        result = await stat(s3_accessor, path, index)
        assert result.name == "file.txt"
        assert result.size == 2048
        assert result.type == FileType.TEXT


class TestReaddirIndexEntries:

    @pytest.mark.asyncio
    async def test_readdir_stores_folder_type(self, s3_accessor, index):
        with patch("mirage.core.s3.readdir.async_session") as mock_session:
            mock_client = AsyncMock()
            page_data = {
                "CommonPrefixes": [{
                    "Prefix": "subdir/data/"
                }],
                "Contents": [{
                    "Key": "subdir/readme.txt",
                    "Size": 100
                }],
            }

            async def _paginate(**kwargs):
                yield page_data

            mock_paginator = MagicMock()
            mock_paginator.paginate = _paginate
            mock_client.get_paginator = MagicMock(return_value=mock_paginator)
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client)

            path = PathSpec(resource_path=mount_key("/s3/subdir", "/s3"),
                            virtual="/s3/subdir",
                            directory="/s3/")
            result = await readdir(s3_accessor, path, index)
            assert "/s3/subdir/data" in result
            assert "/s3/subdir/readme.txt" in result

            lookup = await index.get("/s3/subdir/data")
            assert lookup.entry is not None
            assert lookup.entry.resource_type == "folder"
            assert lookup.entry.name == "data"

            lookup = await index.get("/s3/subdir/readme.txt")
            assert lookup.entry is not None
            assert lookup.entry.resource_type == "file"
            assert lookup.entry.size == 100

    @pytest.mark.asyncio
    async def test_readdir_cache_hit(self, s3_accessor, index):
        with patch("mirage.core.s3.readdir.async_session") as mock_session:
            mock_client = AsyncMock()
            page_data = {
                "CommonPrefixes": [{
                    "Prefix": "subdir/nested/"
                }],
                "Contents": [],
            }

            async def _paginate(**kwargs):
                yield page_data

            mock_paginator = MagicMock()
            mock_paginator.paginate = _paginate
            mock_client.get_paginator = MagicMock(return_value=mock_paginator)
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client)

            path = PathSpec(resource_path=mount_key("/s3/subdir", "/s3"),
                            virtual="/s3/subdir",
                            directory="/s3/")
            r1 = await readdir(s3_accessor, path, index)
            r2 = await readdir(s3_accessor, path, index)
            assert r1 == r2
            assert mock_client.get_paginator.call_count == 1


class TestStatAfterReaddir:

    @pytest.mark.asyncio
    async def test_stat_hits_cache_after_readdir(self, s3_accessor, index):
        with patch("mirage.core.s3.readdir.async_session") as mock_session:
            mock_client = AsyncMock()
            page_data = {
                "CommonPrefixes": [{
                    "Prefix": "subdir/nested/"
                }],
                "Contents": [{
                    "Key": "subdir/readme.txt",
                    "Size": 500
                }],
            }

            async def _paginate(**kwargs):
                yield page_data

            mock_paginator = MagicMock()
            mock_paginator.paginate = _paginate
            mock_client.get_paginator = MagicMock(return_value=mock_paginator)
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client)

            path = PathSpec(resource_path=mount_key("/s3/subdir", "/s3"),
                            virtual="/s3/subdir",
                            directory="/s3/")
            await readdir(s3_accessor, path, index)

        result = await stat(
            s3_accessor,
            PathSpec(resource_path=mount_key("/s3/subdir/nested", "/s3"),
                     virtual="/s3/subdir/nested",
                     directory="/s3/subdir/"), index)
        assert result.name == "nested"
        assert result.type == FileType.DIRECTORY

        result = await stat(
            s3_accessor,
            PathSpec(resource_path=mount_key("/s3/subdir/readme.txt", "/s3"),
                     virtual="/s3/subdir/readme.txt",
                     directory="/s3/subdir/"), index)
        assert result.name == "readme.txt"
        assert result.size == 500
