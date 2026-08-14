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
from mirage.commands.builtin.generic.sha1sum import sha1sum_generic
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          dir_aware_stat,
                                                          dir_aware_stream)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def sha1sum(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
                  texts: list[str],
                  opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    resolved = await resolve_or_empty(ops, accessor, paths, opts.index)
    return await sha1sum_generic(resolved, list(texts), opts,
                                 dir_aware_stat(ops, accessor, opts.index),
                                 dir_aware_stream(ops, accessor, opts.index))


BUILDER = Builder('sha1sum', sha1sum, None, False, None, read=True)
