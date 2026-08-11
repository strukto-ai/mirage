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
from mirage.commands.builtin.generic.shuf import shuf as generic_shuf
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def shuf(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["shuf"])
    output_flag = fl.raw("output")
    output_path = output_flag if isinstance(output_flag, PathSpec) else None
    count_value = fl.as_str("head_count")
    if paths:
        paths = await ops.resolve_glob(accessor, paths, index)
    elif not ops.is_mounted(accessor):
        paths = []
    # Only ``-o`` writes, so a read-only backend still serves plain shuf.
    # Requiring the write op here would break every read-only backend.
    write_op = ops.operation(Operation.WRITE)
    return await generic_shuf(
        paths,
        texts,
        read_bytes=bound_op(ops.read_bytes, accessor, index),
        stdin=stdin,
        count=int(count_value) if count_value is not None else None,
        echo=fl.as_bool("echo"),
        zero_terminated=fl.as_bool("zero_terminated"),
        with_replacement=fl.as_bool("repeat"),
        input_range=fl.as_str("input_range"),
        output=output_path,
        write_bytes=partial(write_op, accessor)
        if write_op is not None else None)


BUILDER = Builder('shuf', shuf, None, False, None, read=True)
