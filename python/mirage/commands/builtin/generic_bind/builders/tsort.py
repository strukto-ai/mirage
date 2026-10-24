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

from collections.abc import AsyncIterator
from contextlib import aclosing

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.stream import stdin_stream
from mirage.commands.config import Context
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.stream import OpenStream, chain_output, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import PathSpec


async def _ordered(
    engine: OpenStream, source: ByteSource, io: IOResult
) -> AsyncIterator[bytes]:
    """The names in order; a loop, an odd token or a graph past what the
    engine holds makes the exit 1."""
    try:
        async with aclosing(chain_output(engine, [source])) as output:
            async for chunk in output:
                yield chunk
    finally:
        if engine.status():
            io.exit_code = 1
            io.stderr = await materialize(io.stderr) + engine.take_stderr()


async def tsort(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    if len(resolved) > 1:
        raise extra_operand_error(
            CommandName.TSORT, resolved[1].raw_path or resolved[1].virtual
        )
    first = resolved[0] if resolved else None
    name = "-" if first is None else first.raw_path or first.virtual
    engine = open_stream("tsort", {"name": byte_view(name)})
    source = (
        ctx.stdin or b""
        if first is None
        else stdin_stream(files.read, ctx.stdin)(first)
    )
    io = IOResult()
    return _ordered(engine, source, io), io


BUILDER = GenericCommand("tsort", tsort, read=True)
