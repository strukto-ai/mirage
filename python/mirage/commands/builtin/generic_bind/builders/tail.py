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
from mirage.commands.builtin.aggregators import header_aggregate
from mirage.commands.builtin.generic.tail import tail_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    dir_aware_stat,
    resolve_or_empty,
)
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tail(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    return await tail_generic(
        resolved,
        list(texts),
        ctx,
        dir_aware_stat(files, ctx),
        files.read,
        (files.read if files.answers("read_range") else None),
        (files.last_lines if files.answers("last_lines") else None),
        (files.follow if files.answers("follow") else None),
    )


BUILDER = GenericCommand("tail", tail, aggregate=header_aggregate, read=True)
