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

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.split import split as generic_split
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def split(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: str | None = None,
    b: str | None = None,
    n: str | None = None,
    d: bool = False,
    a: str | None = None,
    index: IndexCacheStore | None = None,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_or_empty(ops, accessor, paths, index)
    return await generic_split(paths,
                               read_stream=ops.read_stream,
                               write_bytes=ops.write,
                               accessor=accessor,
                               stdin=stdin,
                               lines_per_file=int(args_l) if args_l else 0,
                               byte_limit=int(b) if b else 0,
                               n_chunks=int(n) if n else 0,
                               suffix_len=int(a) if a else 2,
                               numeric_suffix=d)


BUILDER = Builder('split', split, None, True, None)
