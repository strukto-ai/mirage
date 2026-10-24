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
from mirage.commands.builtin.utils.stream import stream_output
from mirage.commands.config import Context, command
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import open_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


@command("seq", vfs=None, spec=SPECS["seq"])
async def seq(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["seq"])
    if not texts:
        raise missing_operand_error(CommandName.SEQ, None)
    if len(texts) > 3:
        raise extra_operand_error(CommandName.SEQ, texts[3])
    typed = fl.as_str("format")
    separator = fl.as_str("separator")
    config: dict[str, JsonValue] = {
        "operands": [byte_view(text) for text in texts],
        "format": None if typed is None else byte_view(typed),
        "equal_width": fl.as_bool("equal_width"),
        "separator": byte_view("\n" if separator is None else separator),
    }
    try:
        engine = open_stream("seq", config)
    except StreamRefusal as refusal:
        raise UsageError(refusal.message, 1) from refusal
    return stream_output(engine, b""), IOResult()
