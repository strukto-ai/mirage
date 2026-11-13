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
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import run_stream
from mirage.shell.bytes import byte_view, utf8_locale
from mirage.types import JsonValue, PathSpec


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
    return run_stream("colrm", config, resolve_source(ctx.stdin)), IOResult()
