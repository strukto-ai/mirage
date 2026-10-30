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
from mirage.commands.builtin.generic.uniq import uniq_flags
from mirage.commands.builtin.generic.uniq import uniq_generic as generic_uniq
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    dir_aware_stat,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import spread_operands
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def uniq(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    groups = [await files.resolve_glob([path]) for path in paths]
    words = [[path.raw_path for path in group] for group in groups]
    parsed = uniq_flags(
        spread_operands(ctx.flags, words),
        [word for group in words for word in group],
    )
    if isinstance(parsed, IOResult):
        return None, parsed
    return await generic_uniq(
        parsed,
        [path for group in groups for path in group],
        read_stream=files.read,
        write_bytes=(files.write if files.answers("write") else None),
        stdin=ctx.stdin,
        stat=dir_aware_stat(files, ctx),
    )


BUILDER = GenericCommand("uniq", uniq, write=True, read=True, streams=True)
