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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    dir_aware_stat,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    per_operand,
    split_readable,
)
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import open_stream, run_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


async def strings(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    min_len = FlagView(ctx.flags, spec=SPECS["strings"]).as_text("n")
    config: dict[str, JsonValue] = {"min_len": min_len and byte_view(min_len)}
    # The engine refuses -n before any operand is touched, as binutils does.
    try:
        open_stream("strings", config)
    except StreamRefusal as refusal:
        return None, IOResult(
            exit_code=1, stderr=f"{refusal.message}\n".encode()
        )
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    # binutils strings never reads `-` as stdin; only /dev/stdin is.
    stat = stdin_stat(dir_aware_stat(files, ctx), dash=False)
    readable, err = await split_readable(resolved, stat, "strings")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    io = IOResult()
    read = stdin_stream(files.read, ctx.stdin, dash=False)
    each = partial(run_stream, "strings", config)
    output = per_operand(readable, read, ctx.stdin, io, "strings", each)
    return await merge_split_errors((output, io), err)


BUILDER = GenericCommand("strings", strings, read=True)
