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
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


async def look(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    words = [*texts, *(path.raw_path for path in resolved)] if texts else []
    fl = FlagView(ctx.flags, spec=SPECS["look"])
    config: dict[str, JsonValue] = {
        "operands": [byte_view(word) for word in words],
        "fold": fl.as_bool("ignore_case"),
        "alphanum": fl.as_bool("alphanum"),
    }
    if (stop := fl.as_str("terminate")) is not None:
        config["terminate"] = byte_view(stop)
    try:
        open_stream("look", config)
    except StreamRefusal as refusal:
        return None, refused(refusal)
    host = StreamHost(
        resolved,
        files.read,
        ctx.stdin,
        None,
        ctx.cwd,
        dash=False,
        command="look",
        sized=(
            file_size(files, ctx, opened=True)
            if files.answers("read_range")
            else None
        ),
    )
    io = IOResult()
    return hosted_stream("look", config, host, io), io


BUILDER = GenericCommand("look", look, read=True, streams=True)
