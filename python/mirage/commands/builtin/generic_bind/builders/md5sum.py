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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.md5sum import md5sum as generic_md5sum
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import (
    merge_split_errors, resolve_readable)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def md5sum(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    c: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    paths, err = await resolve_readable(ops, accessor, paths, index, "md5sum")
    if err and not paths:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await
        generic_md5sum(paths,
                       read_bytes=bound_op(ops.read_bytes, accessor, index),
                       read_stream=bound_op(ops.read_stream, accessor, index),
                       stdin=stdin,
                       check=c), err)


BUILDER = Builder('md5sum', md5sum, None, False, None, read=True)
