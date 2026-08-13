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
from mirage.commands.builtin.generic.sha512sum import sha512sum_generic
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          dir_aware_stat,
                                                          dir_aware_stream)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.config import CommandOpts
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def sha512sum(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore = NULL_INDEX,
    cwd: PathSpec | str = "/",
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    resolved = await resolve_or_empty(ops, accessor, paths, index)
    return await sha512sum_generic(
        resolved, list(texts), CommandOpts(stdin=stdin, flags=flags, cwd=cwd),
        dir_aware_stat(ops, accessor, index),
        dir_aware_stream(ops, accessor, index))


BUILDER = Builder('sha512sum', sha512sum, None, False, None, read=True)
