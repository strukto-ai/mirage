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

import asyncio
from io import BytesIO
from unittest.mock import AsyncMock, MagicMock, patch

from mirage.accessor.s3 import S3Accessor
from mirage.resource.s3 import S3Config
from mirage.types import PathSpec


def _config():
    return S3Accessor(
        S3Config(
            bucket="test-bucket",
            region="us-east-1",
            aws_access_key_id="fake",
            aws_secret_access_key="fake",
        ))


def _mock_session(data: bytes, chunk_size: int = 8192):
    mock_client = AsyncMock()
    body_mock = AsyncMock()
    body_mock.read = AsyncMock(return_value=data)

    async def _iter_chunks(size=chunk_size):
        buf = BytesIO(data)
        while True:
            chunk = buf.read(size)
            if not chunk:
                break
            yield chunk

    body_mock.iter_chunks = _iter_chunks
    mock_client.get_object = AsyncMock(return_value={"Body": body_mock})

    mock_session = MagicMock()
    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=mock_client)
    ctx.__aexit__ = AsyncMock(return_value=False)
    mock_session.client = MagicMock(return_value=ctx)
    return mock_session


def test_read_stream_returns_async_iterator():
    from mirage.core.s3.stream import read_stream
    config = _config()
    session = _mock_session(b"hello world")

    async def _run():
        chunks = []
        async for chunk in read_stream(config,
                                       PathSpec.from_str_path("test.txt")):
            chunks.append(chunk)
        return chunks

    with patch("mirage.core.s3.stream.async_session", return_value=session):
        chunks = asyncio.run(_run())
    assert b"".join(chunks) == b"hello world"


def test_read_stream_yields_chunks():
    from mirage.core.s3.stream import read_stream
    config = _config()
    session = _mock_session(b"a" * 100, chunk_size=30)

    async def _run():
        chunks = []
        async for chunk in read_stream(config,
                                       PathSpec.from_str_path("test.txt"),
                                       chunk_size=30):
            chunks.append(chunk)
        return chunks

    with patch("mirage.core.s3.stream.async_session", return_value=session):
        chunks = asyncio.run(_run())
    assert b"".join(chunks) == b"a" * 100
    assert len(chunks) >= 2


def test_read_bytes_returns_bytes():
    from mirage.core.s3.read import read_bytes
    config = _config()
    session = _mock_session(b"file content here")

    with patch("mirage.core.s3.read.async_session", return_value=session):
        result = asyncio.run(
            read_bytes(config, PathSpec.from_str_path("test.txt")))
    assert isinstance(result, bytes)
    assert result == b"file content here"
