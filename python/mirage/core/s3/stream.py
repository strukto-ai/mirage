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

import time
from collections.abc import AsyncIterator

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexCacheStore
from mirage.core.s3._client import _client_kwargs, _key, async_session
from mirage.observe.context import record, record_stream
from mirage.types import PathSpec


async def read_stream(
    accessor: S3Accessor,
    path: PathSpec,
    index: IndexCacheStore = None,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    """Async generator yielding chunks of an S3 object.

    Args:
        accessor (S3Accessor): S3 accessor.
        path (PathSpec | str): Object path.
        index: Index cache store.
        chunk_size (int): Size of each chunk in bytes.
    """
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original if isinstance(path, PathSpec) else path
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original
    if prefix and path.startswith(prefix):
        path = path[len(prefix):] or "/"
    pin = accessor.revision_pins.get(virtual)
    config = accessor.config
    rec = record_stream("read", path, "s3")
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        kwargs: dict = {"Bucket": config.bucket, "Key": _key(path)}
        if pin:
            kwargs["VersionId"] = pin
        response = await client.get_object(**kwargs)
        async for chunk in response["Body"].iter_chunks(chunk_size):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk


async def range_read(accessor: S3Accessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    """Read a byte range from an S3 object.

    Args:
        accessor (S3Accessor): S3 accessor.
        path (PathSpec | str): Object path.
        start (int): Start byte offset.
        end (int): End byte offset (exclusive).
    """
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original if isinstance(path, PathSpec) else path
    if isinstance(path, PathSpec):
        path = path.strip_prefix
    config = accessor.config
    start_ms = int(time.monotonic() * 1000)
    session = async_session(config)
    async with session.client(**_client_kwargs(config)) as client:
        kwargs: dict = {
            "Bucket": config.bucket,
            "Key": _key(path),
            "Range": f"bytes={start}-{end - 1}",
        }
        pin = accessor.revision_pins.get(virtual)
        if pin:
            kwargs["VersionId"] = pin
        response = await client.get_object(**kwargs)
        data = await response["Body"].read()
        record("read", path, "s3", len(data), start_ms)
        return data
