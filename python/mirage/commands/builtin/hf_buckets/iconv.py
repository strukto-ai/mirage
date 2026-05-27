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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.hf_buckets.glob import resolve_glob
from mirage.core.hf_buckets.read import read_bytes
from mirage.core.hf_buckets.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("iconv", resource="hf_buckets", spec=SPECS["iconv"], write=True)
async def iconv(
    accessor: HfBucketsAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    t: str | None = None,
    c: bool = False,
    o: PathSpec | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    from_enc = f or "utf-8"
    to_enc = t or "utf-8"
    err_mode = "ignore" if c else "strict"
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        raw = await read_bytes(accessor, paths[0])
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raise ValueError("iconv: missing input")
    decoded = raw.decode(from_enc, errors=err_mode)
    encoded = decoded.encode(to_enc, errors=err_mode)
    if o is not None:
        o_path = o.strip_prefix
        await write_bytes(accessor, o_path, encoded)
        return None, IOResult(writes={o_path: encoded})
    return encoded, IOResult()
