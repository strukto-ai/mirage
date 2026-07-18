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
from mirage.commands.builtin.generic.csplit import csplit as generic_csplit
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation,
                                                          with_index)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def csplit(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | PathSpec | None = None,
    n: str | None = None,
    b: str | None = None,
    k: bool = False,
    s: bool = False,
    index: IndexCacheStore | None = None,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_or_empty(ops, accessor, paths, index)
    return await generic_csplit(paths,
                                texts,
                                read_bytes=with_index(ops.read_bytes, index),
                                write_bytes=ops.require(Operation.WRITE),
                                accessor=accessor,
                                stdin=stdin,
                                prefix=f or "xx",
                                digits=int(n) if n else 2,
                                suffix_format=b,
                                keep_on_error=k,
                                silent=s)


BUILDER = Builder('csplit',
                  csplit,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
