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
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import open_stream, run_stream
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
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    words = [*texts, *(path.raw_path for path in resolved)]
    config: dict[str, JsonValue] = {
        "operands": [byte_view(word) for word in words],
        "fold": FlagView(ctx.flags, spec=SPECS["look"]).as_bool("f"),
    }
    try:
        open_stream("look", config)
    except StreamRefusal as refusal:
        return None, refused(refusal)
    io = IOResult(exit_code=1)
    if not resolved:
        return _matched(resolve_source(ctx.stdin), config, io), io
    source = normalized_read(files.read)(resolved[0])
    output = _matched(source, config, io)
    return reported_stream(output, io, resolved[0], "look"), io


BUILDER = GenericCommand("look", look, read=True)
