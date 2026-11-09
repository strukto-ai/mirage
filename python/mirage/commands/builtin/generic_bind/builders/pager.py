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

import re

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

# The start positions more takes; any other word is a file to it.
MORE_POSITION = re.compile(r"\+(?:[0-9]+\Z|/)")


def _is_file(word: str, command: str) -> bool:
    """Whether an operand names a file, not where to start reading.

    Args:
        word (str): the operand.
        command (str): the pager.
    """
    if command == "zmore":
        return True
    if command == "more":
        return MORE_POSITION.match(word) is None
    return not word.startswith("+")


def _pager(command: str) -> CommandFn:
    async def page(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
    ) -> tuple[ByteSource | None, IOResult]:
        operands = [p for p in paths if _is_file(p.raw_path, command)]
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
