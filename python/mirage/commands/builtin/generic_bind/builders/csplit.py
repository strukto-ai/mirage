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
from mirage.commands.builtin.generic.csplit import csplit as generic_csplit
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def csplit(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    f: str | PathSpec | None = None,
    n: str | None = None,
    b: str | None = None,
    k: bool = False,
    s: bool = False,
    z: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **flags,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["csplit"])
    paths = await resolve_or_empty(ops, accessor, paths, index)
    prefix_flag = fl.raw("prefix")
    prefix = prefix_flag if isinstance(prefix_flag,
                                       (str, PathSpec)) else f or "xx"
    return await generic_csplit(
        paths,
        texts,
        read_bytes=bound_op(ops.read_bytes, accessor, index),
        write_bytes=partial(ops.require(Operation.WRITE), accessor),
        stdin=stdin,
        prefix=prefix,
        digits=int(n or fl.as_str("digits") or "2"),
        suffix_format=b or fl.as_str("suffix_format"),
        keep_on_error=k or fl.as_bool("keep_files"),
        silent=s or fl.as_bool("quiet") or fl.as_bool("silent"),
        suppress_matched=fl.as_bool("suppress_matched"),
        elide_empty=z or fl.as_bool("elide_empty_files"))


BUILDER = Builder('csplit',
                  csplit,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
