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

from mirage.accessor.history import HistoryAccessor
from mirage.commands.builtin.aggregators import header_aggregate
from mirage.commands.builtin.generic.tail import tail_generic
from mirage.commands.builtin.generic_bind.adapter import (bound_op,
                                                          dir_aware_stat)
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.builtin.history.io import IO
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail",
         resource="history",
         spec=SPECS["tail"],
         aggregate=header_aggregate)
async def tail(accessor: HistoryAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    return await tail_generic(resolved, list(texts), opts,
                              dir_aware_stat(IO, accessor, opts.index),
                              bound_op(IO.read_stream, accessor, opts.index))
