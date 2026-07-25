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
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def md5sum(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    c: bool = False,
    b: bool = False,
    t: bool = False,
    w: bool = False,
    z: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["md5sum"])
    paths, err = await resolve_readable(ops, accessor, paths, index, "md5sum")
    if err and not paths:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await
        generic_md5sum(paths,
                       read_bytes=bound_op(ops.read_bytes, accessor, index),
                       read_stream=bound_op(ops.read_stream, accessor, index),
                       stdin=stdin,
                       check=c or fl.as_bool("check"),
                       binary=b or fl.as_bool("binary"),
                       tag=fl.as_bool("tag"),
                       zero=z or fl.as_bool("zero"),
                       strict=fl.as_bool("strict"),
                       ignore_missing=fl.as_bool("ignore_missing"),
                       status=fl.as_bool("status"),
                       quiet=fl.as_bool("quiet"),
                       warn=w or fl.as_bool("warn")), err)


BUILDER = Builder('md5sum', md5sum, None, False, None, read=True)
