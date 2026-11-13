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
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import run_stream
from mirage.shell.bytes import byte_view, from_byte_view, utf8_locale
from mirage.types import JsonValue, PathSpec


async def _removed(
    source: ByteSource, config: Mapping[str, JsonValue], io: IOResult
) -> AsyncIterator[bytes]:
    try:
        async with aclosing(run_stream("colrm", config, source)) as output:
            async for chunk in output:
                yield chunk
    except StreamRefusal as refusal:
        io.exit_code = refusal.status
        io.stderr = from_byte_view(refusal.message) + b"\n"
        if refusal.output:
            yield refusal.output


@command("colrm", vfs=None, spec=SPECS["colrm"])
async def colrm(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Remove columns from standard input."""
    config: dict[str, JsonValue] = {
        "args": [byte_view(text) for text in texts],
        "utf8": utf8_locale(ctx.env),
    }
    io = IOResult()
    return _removed(resolve_source(ctx.stdin), config, io), io
