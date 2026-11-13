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
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import run_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


@command("envsubst", vfs=None, spec=SPECS["envsubst"])
async def envsubst(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Substitute environment values or list a format's variable names."""
    variables = FlagView(ctx.flags, spec=SPECS["envsubst"]).as_bool(
        "variables"
    )
    config: dict[str, JsonValue] = {
        "args": [byte_view(text) for text in texts],
        "variables": variables,
        "env": {}
        if variables
        else {
            byte_view(name): byte_view(value)
            for name, value in (ctx.env or {}).items()
        },
    }
    source = b"" if variables else resolve_source(ctx.stdin)
    return run_stream("envsubst", config, source), IOResult()
