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
from mirage.commands.builtin.generic.sha384sum import \
    sha384sum as generic_sha384sum
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import (
    merge_split_errors, resolve_readable)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def sha384sum(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore = NULL_INDEX,
    cwd: PathSpec | str = "/",
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["sha384sum"])
    paths, err = await resolve_readable(ops, accessor, paths, index,
                                        "sha384sum")
    if err and not paths:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await generic_sha384sum(paths,
                                read_bytes=bound_op(ops.read_bytes, accessor,
                                                    index),
                                read_stream=bound_op(ops.read_stream, accessor,
                                                     index),
                                stdin=stdin,
                                check=fl.as_bool("check"),
                                binary=fl.as_bool("binary"),
                                tag=fl.as_bool("tag"),
                                zero=fl.as_bool("zero"),
                                strict=fl.as_bool("strict"),
                                ignore_missing=fl.as_bool("ignore_missing"),
                                status=fl.as_bool("status"),
                                quiet=fl.as_bool("quiet"),
                                warn=fl.as_bool("warn"),
                                cwd=cwd), err)


BUILDER = Builder('sha384sum', sha384sum, None, False, None, read=True)
