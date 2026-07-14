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
from mirage.commands.builtin.generic.rev import rev as generic_rev
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          with_index)
from mirage.commands.builtin.generic_bind.builders.common import (
    merge_split_errors, resolve_readable)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def rev(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    paths, err = await resolve_readable(ops, accessor, paths, index, "rev")
    if err and not paths:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await generic_rev(paths,
                          read_bytes=with_index(ops.read_bytes, index),
                          accessor=accessor,
                          stdin=stdin), err)


BUILDER = Builder('rev', rev, None, False, None, read=True)
