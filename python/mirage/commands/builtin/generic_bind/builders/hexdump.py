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
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    file_size,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView, spec_flag_names
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


async def hexdump(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    # mirage-rs reads every option in the order typed, so each display
    # option and format string adds its formats where it stands, a format
    # file by the name typed; `-` names a file, as util-linux's hexdump
    # reads it.
    fl = FlagView(ctx.flags, spec=SPECS["hexdump"])
    config: dict[str, JsonValue] = {
        "options": [
            [
                name,
                value
                if isinstance(value, bool)
                else byte_view(
                    value.raw_path
                    if isinstance(value, PathSpec)
                    else str(value)
                ),
            ]
            for name, value in fl.occurrences(
                *spec_flag_names(SPECS["hexdump"])
            )
        ],
        "operands": [byte_view(path.raw_path) for path in resolved],
    }
    host = StreamHost(
        resolved,
        files.read,
        ctx.stdin,
        dispatch_of(ctx),
        ctx.cwd,
        dash=False,
        command="hexdump",
        sized=(
            file_size(files, ctx, opened=True)
            if files.answers("read_range")
            else None
        ),
    )
    io = IOResult()
    return hosted_stream("hexdump", config, host, io), io


BUILDER = GenericCommand(
    "hexdump", hexdump, read=True, streams=True, gives_back=True
)
