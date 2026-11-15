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
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandSpec
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


async def run_command(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Run one office command through mirage-rs, which reads the
    workbook from a host spool and writes it back through the mount that
    owns it, every part the command leaves alone copied as it stands.

    Args:
        accessor (Accessor): unused; office holds no account.
        paths (list[PathSpec]): the workbook.
        texts (list[str]): the DOM path or selector, when the command
            takes one.
        ctx (Context): the command's context.
    """
    spec = ctx.spec or CommandSpec()
    flags = FlagView(ctx.flags, spec=spec)
    name = spec.name
    workbook = paths[0]
    operands = [workbook]
    config: dict[str, JsonValue] = {
        "command": name,
        "file": byte_view(workbook.raw_path),
        "absolute": byte_view(workbook.virtual),
        "path": texts[0] if texts else "/",
        "json": flags.as_bool("json"),
    }
    if name in ("set", "add"):
        config["props"] = list(flags.as_list("prop"))
    if name in ("create", "batch", "add"):
        config["force"] = flags.as_bool("force")
    if name in ("add", "move"):
        config["index"] = flags.as_int("index")
        config["after"] = flags.as_str("after")
        config["before"] = flags.as_str("before")
    if name == "add":
        config["type"] = flags.as_str("type")
        config["from"] = flags.as_str("from")
    if name == "move":
        config["to"] = flags.as_str("to")
    if name == "swap":
        config["path2"] = texts[1] if len(texts) > 1 else ""
    if name == "get":
        config["depth"] = flags.as_int("depth")
    if name == "query":
        config["find"] = flags.as_str("find")
    if name == "batch":
        config["commands"] = flags.as_str("commands")
        config["stop_on_error"] = flags.as_bool("stop_on_error")
        config["best_effort"] = flags.as_bool("best_effort")
        source = flags.as_path("input")
        if source is not None and source.raw_path != "-":
            operands.append(source)
            config["input"] = byte_view(source.raw_path)
            config["input_absolute"] = byte_view(source.virtual)
        elif source is not None:
            config["input"] = "-"
    files = command_files(ctx, operands)
    host = StreamHost(
        operands,
        normalized_read(files.read),
        ctx.stdin,
        dispatch_of(ctx),
        ctx.cwd,
        dash=False,
    )
    io = IOResult()
    return hosted_stream("office", config, host, io), io
