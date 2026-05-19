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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.split import split as generic_split
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ram.glob import resolve_glob
from mirage.core.ram.stream import stream as _stream_core
from mirage.core.ram.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("split", resource="ram", spec=SPECS["split"], write=True)
async def split(
    accessor: RAMAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: str | None = None,
    b: str | None = None,
    n: str | None = None,
    d: bool = False,
    a: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths and accessor.store is not None:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_split(paths,
                               read_stream=_stream_core,
                               write_bytes=write_bytes,
                               accessor=accessor,
                               stdin=stdin,
                               lines_per_file=int(args_l) if args_l else 0,
                               byte_limit=int(b) if b else 0,
                               n_chunks=int(n) if n else 0,
                               suffix_len=int(a) if a else 2,
                               numeric_suffix=d)
