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
from mirage.commands.builtin.generic.rg import rg_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
)
from mirage.commands.builtin.generic_bind.search import search_reads
from mirage.commands.config import CommandIO, CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def rg(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if paths and ops.is_mounted(accessor):
        paths = await ops.resolve_glob(accessor, paths, opts.index)
    read_bytes, read_stream = await search_reads(
        ops, "rg", accessor, paths, texts, opts
    )
    return await rg_generic(
        paths,
        texts,
        opts,
        readdir=bound_op(ops.readdir, accessor, opts.index),
        stat=bound_op(ops.stat, accessor, opts.index),
        read_bytes=read_bytes,
        read_stream=read_stream,
        stdin=opts.stdin,
    )


BUILDER = GenericCommand("rg", rg, read=True)
