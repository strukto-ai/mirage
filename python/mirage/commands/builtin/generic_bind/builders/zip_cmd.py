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
from mirage.commands.builtin.generic.zip_cmd import zip_generic
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.builtin.generic_bind.archive_io import walk_of
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def zip_cmd(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
                  texts: list[str],
                  opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or not paths:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    resolved = await ops.resolve_glob(accessor, paths, opts.index)
    return await zip_generic(resolved, list(texts), opts,
                             bound_op(ops.read_bytes, accessor, opts.index),
                             partial(ops.require(Operation.WRITE), accessor),
                             partial(ops.stat, accessor, index=opts.index),
                             walk_of(ops, accessor, opts.index))


BUILDER = Builder('zip',
                  zip_cmd,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
