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

from collections.abc import AsyncIterator, Mapping
from contextlib import aclosing

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.operands import (
    normalized_read,
    reported_stream,
)
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error, usage_hint
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import run_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


async def _matched(
    source: ByteSource, config: Mapping[str, JsonValue], io: IOResult
) -> AsyncIterator[bytes]:
    """The lines that start with the prefix; one makes the exit 0."""
    async with aclosing(run_stream("look", config, source)) as output:
        async for chunk in output:
            io.exit_code = 0
            yield chunk


async def look(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        # util-linux 2.41 answers a missing prefix with its usage refusal.
        raise UsageError(f"look: bad usage\n{usage_hint('look')}", 1)
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    if len(resolved) > 1:
        raise extra_operand_error(
            CommandName.LOOK, resolved[1].raw_path or resolved[1].virtual
        )
    config: dict[str, JsonValue] = {
        "prefix": byte_view(texts[0]),
        "fold": FlagView(ctx.flags, spec=SPECS["look"]).as_bool("f"),
    }
    io = IOResult(exit_code=1)
    if not resolved:
        return _matched(resolve_source(ctx.stdin), config, io), io
    source = normalized_read(files.read)(resolved[0])
    output = _matched(source, config, io)
    return reported_stream(output, io, resolved[0], "look"), io


BUILDER = GenericCommand("look", look, read=True)
