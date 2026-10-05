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

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.builtin.discord.io import IO
from mirage.commands.builtin.generic.head import head_generic
from mirage.commands.builtin.generic_bind.adapter import (
    bound_op,
    resolve_or_empty,
)
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.core.discord.read import read as discord_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("head", vfs="discord", spec=SPECS["head"])
async def head(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    return await head_generic(
        resolved,
        list(texts),
        opts,
        bound_op(IO.stat, accessor, opts.index),
        bound_op(discord_read, accessor, opts.index),
    )
