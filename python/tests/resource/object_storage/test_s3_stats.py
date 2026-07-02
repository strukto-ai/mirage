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

from mirage.accessor.s3 import S3Accessor
from mirage.resource.s3 import S3Config, S3Resource
from mirage.types import PathSpec


@pytest.fixture
def s3_config():
    return S3Config(bucket="test-bucket", region="us-east-1")


@pytest.fixture
def s3_accessor(s3_config):
    return S3Accessor(s3_config)


@pytest.fixture
def s3_backend(s3_config):
    return S3Resource(s3_config)


@pytest.mark.asyncio
async def test_get_bytes(s3_accessor):
    from mirage.core.s3.read import read_bytes

    with patch("mirage.core.s3.read.async_session") as mock_session:
        mock_client = AsyncMock()
        mock_body = AsyncMock()
        mock_body.read.return_value = b"hello world\nfoo bar\nbaz"
        mock_client.get_object.return_value = {"Body": mock_body}
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__.return_value = mock_client
        mock_session.return_value.client.return_value = mock_ctx
        data = await read_bytes(
            s3_accessor,
            PathSpec(resource_path="data/file.txt",
                     virtual="/data/file.txt",
                     directory="/data/file.txt"))
        assert data == b"hello world\nfoo bar\nbaz"


@pytest.mark.asyncio
async def test_range_get(s3_accessor):
    from mirage.core.s3.read import read_bytes

    with patch("mirage.core.s3.read.async_session") as mock_session:
        mock_client = AsyncMock()
        mock_body = AsyncMock()
        mock_body.read.return_value = b"hello"
        mock_client.get_object.return_value = {"Body": mock_body}
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__.return_value = mock_client
        mock_session.return_value.client.return_value = mock_ctx
        data = await read_bytes(s3_accessor,
                                PathSpec(resource_path="data/file.txt",
                                         virtual="/data/file.txt",
                                         directory="/data/file.txt"),
                                offset=0,
                                size=5)
        assert data == b"hello"
        mock_client.get_object.assert_called_once()
        call_kwargs = mock_client.get_object.call_args[1]
        assert "Range" in call_kwargs
        assert call_kwargs["Range"] == "bytes=0-4"


@pytest.mark.asyncio
async def test_put_bytes(s3_accessor):
    from mirage.core.s3.write import write_bytes

    with patch("mirage.core.s3.write.async_session") as mock_session:
        mock_client = AsyncMock()
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__.return_value = mock_client
        mock_session.return_value.client.return_value = mock_ctx
        await write_bytes(
            s3_accessor,
            PathSpec(resource_path="data/out.txt",
                     virtual="/data/out.txt",
                     directory="/data/out.txt"), b"hello")
        mock_client.put_object.assert_called_once()
        call_kwargs = mock_client.put_object.call_args[1]
        assert call_kwargs["Body"] == b"hello"
        assert call_kwargs["Key"] == "data/out.txt"
