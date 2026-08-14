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
from mirage.commands.builtin.generic.tee import tee as generic_tee
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tee(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
              texts: list[str],
              opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tee: missing operand")
    paths = await ops.resolve_glob(accessor, paths, opts.index)
    # A backend that can append natively does; the rest fall back to the
    # read-modify-write inside the generic.
    append = ops.append
    return await generic_tee(
        paths,
        texts,
        read_stream=bound_op(ops.read_stream, accessor, opts.index),
        write_bytes=partial(ops.require(Operation.WRITE), accessor),
        append_bytes=(None if append is None else partial(append, accessor)),
        stdin=opts.stdin,
        flags=opts.flags)


BUILDER = Builder('tee',
                  tee,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
