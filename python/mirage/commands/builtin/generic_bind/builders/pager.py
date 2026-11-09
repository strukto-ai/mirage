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
from mirage.commands.builtin.generic.pager import pager_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    dir_aware_stream,
    resolve_or_empty,
)
from mirage.commands.config import CommandFn, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _pager(command: str) -> CommandFn:
    async def page(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> tuple[ByteSource | None, IOResult]:
        operands = [p for p in paths if not p.raw_path.startswith("+")]
        files = command_files(ctx, operands)
        resolved = await resolve_or_empty(files, operands)
        return await pager_generic(
            resolved,
            list(texts),
            ctx,
            dir_aware_stream(files, ctx),
            command,
        )

    return page


BUILDERS = tuple(
    GenericCommand(name, _pager(name), read=True, pass_through=True)
    for name in ("less", "more", "zless", "zmore")
)
