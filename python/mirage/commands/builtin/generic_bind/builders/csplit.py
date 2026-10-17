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
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def csplit(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["csplit"])
    paths = await resolve_or_empty(ops, accessor, paths, ctx.index)
    prefix_flag = fl.raw("prefix")
    prefix = prefix_flag if isinstance(prefix_flag, (str, PathSpec)) else "xx"
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
        read_bytes=bound_op(ops.read_stream, accessor, ctx.index),
        write_bytes=write_bytes,
        unlink=unlink,
        stdin=ctx.stdin,
        prefix=prefix,
        mount_prefix=ctx.mount_prefix,
        cwd=ctx.cwd.virtual,
        digits=int(fl.as_str("digits") or "2"),
        suffix_format=fl.as_str("suffix_format"),
        keep_on_error=fl.as_bool("keep_files"),
        silent=fl.as_bool("quiet") or fl.as_bool("silent"),
        suppress_matched=fl.as_bool("suppress_matched"),
        elide_empty=fl.as_bool("elide_empty_files"),
    )


BUILDER = GenericCommand("csplit", csplit, write=True)
