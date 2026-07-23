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
from mirage.commands.builtin.generic.paste import paste as generic_paste
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def paste(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    d: str | None = None,
    s: bool = False,
    z: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["paste"])
    paths = await resolve_or_empty(ops, accessor, paths, index)
    return await generic_paste(
        paths,
        read_bytes=bound_op(ops.read_bytes, accessor, index),
        stdin=stdin,
        delimiters=d or fl.as_str("delimiters") or "\t",
        serial=s or fl.as_bool("serial"),
        zero_terminated=(z or fl.as_bool("zero_terminated")))


BUILDER = Builder('paste', paste, None, False, None, read=True)
