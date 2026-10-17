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
from mirage.commands.builtin.generic.crossmount.utils import (
    transfer_primitives,
)
from mirage.commands.builtin.generic.csplit import (
    csplit_generic as generic_csplit,
)
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    bound_op,
    dispatched_call,
    require_op,
    resolve_or_empty,
)
from mirage.commands.config import CommandIO, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def csplit(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_or_empty(ops, accessor, paths, ctx.index)
    # The pieces go to the prefix, or `xx` in the working directory, which
    # need not be this mount, so a dispatcher routes each write, and the
    # removal of a failed run's pieces, to the mount that owns it.
    if ctx.dispatch is not None:
        write_bytes = transfer_primitives(ctx.dispatch)["write"]
        unlink = partial(dispatched_call, ctx.dispatch, "unlink")
    else:
        write_bytes = partial(require_op(ops, Operation.WRITE), accessor)
        unlink = partial(require_op(ops, Operation.UNLINK), accessor)
    return await generic_csplit(
        paths,
        texts,
        ctx,
        read_bytes=bound_op(ops.read_stream, accessor, ctx.index),
        write_bytes=write_bytes,
        unlink=unlink,
    )


BUILDER = GenericCommand("csplit", csplit, write=True)
