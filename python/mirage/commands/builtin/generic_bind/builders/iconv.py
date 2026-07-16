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
from mirage.commands.builtin.generic.iconv import iconv as generic_iconv
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          with_index)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def iconv(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    t: str | None = None,
    c: bool = False,
    o: PathSpec | None = None,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_or_empty(ops, accessor, paths, index)
    return await generic_iconv(paths,
                               read_bytes=with_index(ops.read_bytes, index),
                               write_bytes=ops.require("write"),
                               accessor=accessor,
                               stdin=stdin,
                               from_enc=f or "utf-8",
                               to_enc=t or "utf-8",
                               ignore_errors=c,
                               output_path=o)


BUILDER = Builder('iconv', iconv, None, True, None)
