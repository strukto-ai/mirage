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

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexCacheStore
from mirage.core.s3._client import _client_kwargs, _key, async_session
from mirage.observe.context import record
from mirage.types import PathSpec


async def read_bytes(accessor: S3Accessor,
                     path: PathSpec,
                     index: IndexCacheStore = None,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    """Read bytes from S3, with optional range read.

    Args:
        accessor (S3Accessor): S3 accessor.
        path (PathSpec | str): Object path.
        index: Index cache store.
        prefix (str): Mount prefix.
        offset (int): Byte offset for range reads.
        size (int | None): Number of bytes for range reads.
    """
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original if isinstance(path, PathSpec) else path
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original
    if prefix and path.startswith(prefix):
        path = path[len(prefix):] or "/"
    config = accessor.config
    key = _key(path)
    kwargs = {"Bucket": config.bucket, "Key": key}
    pin = accessor.revision_pins.get(virtual)
    if pin:
        kwargs["VersionId"] = pin
    if offset or size is not None:
        end = (offset + size - 1) if size is not None else ""
        kwargs["Range"] = f"bytes={offset}-{end}"
    session = async_session(config)
    start_ms = int(time.monotonic() * 1000)
    try:
        async with session.client(**_client_kwargs(config)) as client:
            resp = await client.get_object(**kwargs)
            data = await resp["Body"].read()
            record("read", path, "s3", len(data), start_ms)
            return data
    except Exception as exc:
        if (hasattr(exc, "response")
                and exc.response.get("Error", {}).get("Code") == "NoSuchKey"):
            raise FileNotFoundError(path)
        raise
