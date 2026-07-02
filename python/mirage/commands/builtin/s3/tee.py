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

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.glob import resolve_glob
from mirage.core.s3.stream import read_stream
from mirage.core.s3.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tee", resource="s3", spec=SPECS["tee"], write=True)
async def tee(
    accessor: S3Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    a: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tee: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raw = (" ".join(texts)).encode() if texts else b""
    write_data = raw
    if a:
        try:
            existing = b""
            async for chunk in read_stream(accessor, paths[0]):
                existing += chunk
            write_data = existing + raw
        except FileNotFoundError:
            pass
    await write_bytes(accessor, paths[0], write_data)
    return raw, IOResult(writes={paths[0].mount_path: write_data},
                         cache=[paths[0].mount_path])
