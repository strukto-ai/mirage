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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.s3 import S3Accessor
from mirage.core.s3.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.s3 import S3Config


@pytest.fixture
def s3_config():
    return S3Config(bucket="test-bucket", region="us-east-1")


@pytest.fixture
def s3_accessor(s3_config):
    return S3Accessor(s3_config)


def _mock_client_ctx(mock_client):
    mock_ctx = AsyncMock()
    mock_ctx.__aenter__.return_value = mock_client
    return mock_ctx


class TestStatDirectoryFallback:
    @pytest.mark.asyncio
    async def test_stat_file_returns_filestat(self, s3_accessor):
        with patch("mirage.core.s3.driver.async_session") as mock_session:
            mock_client = AsyncMock()
            mock_client.head_object.return_value = {
                "ContentLength": 1024,
                "LastModified": datetime(2026, 1, 1, tzinfo=timezone.utc),
                "ETag": '"abc123"',
            }
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client
            )

            path = PathSpec(
                vfs_path=mount_key("/s3/data/file.txt", "/s3"),
                virtual="/s3/data/file.txt",
                directory="/s3/data/",
            )
            result = await stat(s3_accessor, path)
            assert result.name == "file.txt"
            assert result.size == 1024
            assert result.content == ContentType.TEXT

    @pytest.mark.asyncio
    async def test_stat_directory_prefix_fallback(self, s3_accessor):
        with patch("mirage.core.s3.driver.async_session") as mock_session:
            mock_client = AsyncMock()
            err = Exception("not found")
            err.response = {"Error": {"Code": "404"}}
            mock_client.head_object.side_effect = err
            mock_client.list_objects_v2.return_value = {
                "CommonPrefixes": [{"Prefix": "data/subdir/"}],
            }
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client
            )

            path = PathSpec(
                vfs_path=mount_key("/s3/data", "/s3"),
                virtual="/s3/data",
                directory="/s3/",
            )
            result = await stat(s3_accessor, path)
            assert result.name == "data"
            assert result.type == FileType.DIRECTORY

    @pytest.mark.asyncio
    async def test_stat_directory_prefix_with_contents(self, s3_accessor):
        with patch("mirage.core.s3.driver.async_session") as mock_session:
            mock_client = AsyncMock()
            err = Exception("not found")
            err.response = {"Error": {"Code": "NoSuchKey"}}
            mock_client.head_object.side_effect = err
            mock_client.list_objects_v2.return_value = {
                "Contents": [{"Key": "data/file.txt"}],
            }
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client
            )

            path = PathSpec(
                vfs_path=mount_key("/s3/data", "/s3"),
                virtual="/s3/data",
                directory="/s3/",
            )
            result = await stat(s3_accessor, path)
            assert result.name == "data"
            assert result.type == FileType.DIRECTORY

    @pytest.mark.asyncio
    async def test_stat_nonexistent_raises(self, s3_accessor):
        with patch("mirage.core.s3.driver.async_session") as mock_session:
            mock_client = AsyncMock()
            err = Exception("not found")
            err.response = {"Error": {"Code": "404"}}
            mock_client.head_object.side_effect = err
            mock_client.list_objects_v2.return_value = {}
            mock_session.return_value.client.return_value = _mock_client_ctx(
                mock_client
            )

            path = PathSpec(
                vfs_path=mount_key("/s3/nope", "/s3"),
                virtual="/s3/nope",
                directory="/s3/",
            )
            with pytest.raises(FileNotFoundError):
                await stat(s3_accessor, path)

    @pytest.mark.asyncio
    async def test_stat_root_returns_directory(self, s3_accessor):
        path = PathSpec(
            vfs_path=mount_key("/s3/", "/s3"), virtual="/s3/", directory="/s3/"
        )
        result = await stat(s3_accessor, path)
        assert result.name == "/"
        assert result.type == FileType.DIRECTORY
