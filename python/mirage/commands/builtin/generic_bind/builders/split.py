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
    resolve_or_empty,
)
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
    own_mount,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec

FLAGS = (
    "lines",
    "bytes",
    "number",
    "suffix_length",
    "numeric_suffixes",
    "hex_suffixes",
    "additional_suffix",
    "separator",
)


async def split(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    fl = FlagView(ctx.flags, spec=SPECS["split"])
    paths = await resolve_or_empty(files, paths)
    # mirage-rs reads each value as typed, so an explicitly empty one is
    # refused as GNU refuses it; -d and -x come as `true` without one.
    config: dict[str, JsonValue] = {
        name: value if isinstance(value, bool) else byte_view(value)
        for name in FLAGS
        if isinstance(value := fl.raw(name), (str, bool))
    }
    config["operands"] = [byte_view(path.raw_path) for path in paths]
    # The pieces go to the prefix, or `x` in the working directory, which
    # need not be this mount, so the dispatcher routes each write.
    host = StreamHost(
        paths,
        normalized_read(files.read),
        ctx.stdin,
        dispatch_of(ctx),
        ctx.cwd,
        None,
        own_mount,
        command="split",
    )
    io = IOResult()
    return hosted_stream("split", config, host, io), io


BUILDER = GenericCommand("split", split, write=True)
