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

from collections.abc import AsyncIterator
from contextlib import aclosing

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.core.tidb_filesystem.client import download_stream
from mirage.core.tidb_filesystem.path import backend_path
from mirage.core.tidb_filesystem.read import read_error
from mirage.observe.context import record_stream
from mirage.types import PathSpec


async def read_stream(
    accessor: TiDBFilesystemAccessor,
    path: PathSpec,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    rec = record_stream("read", path.virtual, "tidb_filesystem")
    remote_path = backend_path(accessor.config, path)
    try:
        async with aclosing(download_stream(accessor, remote_path)) as stream:
            async for data in stream:
                for offset in range(0, len(data), chunk_size):
                    chunk = data[offset : offset + chunk_size]
                    if rec is not None:
                        rec.bytes += len(chunk)
                    yield chunk
    except Exception as exc:
        error = await read_error(accessor, path, exc)
        if error is None:
            raise
        raise error from exc
