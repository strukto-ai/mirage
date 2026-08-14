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
from mirage.commands.builtin.generic.cmp import cmp_generic
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def cmp_cmd(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
                  texts: list[str],
                  opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError('cmp: requires two paths')
    resolved = await ops.resolve_glob(accessor, paths, opts.index)
    return await cmp_generic(resolved, list(texts), opts,
                             bound_op(ops.read_bytes, accessor, opts.index))


BUILDER = Builder('cmp', cmp_cmd, None, False, None, read=True)
