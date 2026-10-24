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
    dir_aware_stat,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    normalized_read,
    reported_stream,
    split_readable,
)
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import OpenStream, Served, open_stream, serve_requests
from mirage.shell.bytes import byte_view, utf8_locale
from mirage.types import JsonValue, PathSpec


class _Spooled:
    """The input in hand, held whole, which the engine reads back a block
    at a time and has written out a record at a time."""

    def __init__(self) -> None:
        self.spool = ByteSpool()
        self.errors = ByteSpool()

    async def serve(
        self, request: Mapping[str, JsonValue], data: bytes
    ) -> Served:
        offset, size = request["offset"], request["size"]
        assert isinstance(offset, int) and isinstance(size, int)
        if request["op"] == "emit":
            return Served({}, output=self.spool.stream(offset, size))
        return Served({}, await self.spool.read(offset, size))


async def _reversed(
    engine: OpenStream, sources: list[ByteSource], io: IOResult
) -> AsyncIterator[bytes]:
    """Each input reversed in turn; running out of memory ends the run,
    exit 1."""
    host = _Spooled()
    try:
        for source in sources:
            async with ByteSpool() as host.spool:
                await host.spool.fill(source)
                engine.begin({"size": host.spool.size})
                async with aclosing(serve_requests(engine, host)) as output:
                    async for chunk in output:
                        yield chunk
            if engine.status():
                break
    finally:
        if engine.status():
            io.exit_code = 1
            io.stderr = await materialize(io.stderr) + await materialize(
                await host.errors.output()
            )
        await host.errors.close()


async def tac(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["tac"])
    separator = fl.as_str("separator")
    try:
        engine = open_stream(
            "tac",
            {
                "separator": separator and byte_view(separator),
                "before": fl.as_bool("before"),
                "regex": fl.as_bool("regex"),
                "utf8": utf8_locale(ctx.env),
            },
        )
    except StreamRefusal as refusal:
        return None, IOResult(
            exit_code=1, stderr=f"{refusal.message}\n".encode()
        )
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    stat = stdin_stat(dir_aware_stat(files, ctx))
    readable, err = await split_readable(resolved, stat, "tac")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    io = IOResult()
    read = normalized_read(stdin_stream(files.read, ctx.stdin))
    sources: list[ByteSource] = [
        reported_stream(read(path), io, path, "tac") for path in readable
    ] or [resolve_source(ctx.stdin)]
    return await merge_split_errors((_reversed(engine, sources, io), io), err)


BUILDER = GenericCommand("tac", tac, read=True)
