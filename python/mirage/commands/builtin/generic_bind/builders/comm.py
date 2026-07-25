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
from mirage.commands.builtin.generic.comm import comm as generic_comm
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def comm(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    check_order: bool = False,
    z: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["comm"])
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError("comm: requires two paths")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_comm(
        paths,
        read_bytes=bound_op(ops.read_bytes, accessor, index),
        suppress1=fl.as_bool("args_1"),
        suppress2=fl.as_bool("2"),
        suppress3=fl.as_bool("3"),
        check_order=check_order or fl.as_bool("check_order"),
        output_delimiter=fl.as_str("output_delimiter") or "\t",
        total=fl.as_bool("total"),
        zero_terminated=z or fl.as_bool("zero_terminated"),
    )


BUILDER = Builder('comm', comm, None, False, None, read=True)
