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
from mirage.commands.builtin.aggregators import prefix_aggregate
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def grep(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    resolved = (await ops.resolve_glob(accessor, paths, opts.index)
                if paths and ops.is_mounted(accessor) else [])
    return await generic_grep(
        resolved,
        texts,
        opts.flags,
        readdir=bound_op(ops.readdir, accessor, opts.index),
        stat=bound_op(ops.stat, accessor, opts.index),
        read_bytes=bound_op(ops.read_bytes, accessor, opts.index),
        read_stream=bound_op(ops.read_stream, accessor, opts.index),
        stdin=opts.stdin,
    )


BUILDER = Builder('grep', grep, None, False, prefix_aggregate, read=True)
