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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.gzip import extract_level
from mirage.commands.builtin.generic.gzip import gzip as generic_gzip
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def gzip(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    d: bool = False,
    k: bool = False,
    f: bool = False,
    c: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    level = extract_level(flags)
    if paths:
        paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_gzip(paths,
                              read_bytes=bound_op(ops.read_bytes, accessor,
                                                  index),
                              write_bytes=partial(ops.require(Operation.WRITE),
                                                  accessor),
                              unlink=partial(ops.require(Operation.UNLINK),
                                             accessor),
                              stdin=stdin,
                              decompress=d,
                              keep=k,
                              force=f,
                              to_stdout=c,
                              level=level)


BUILDER = Builder('gzip',
                  gzip,
                  write=True,
                  requirements=frozenset({Operation.WRITE, Operation.UNLINK}))
