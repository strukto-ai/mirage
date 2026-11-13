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
from collections.abc import AsyncGenerator, Mapping
from contextlib import aclosing

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import close_stream, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec


async def _substituted(
    source: ByteSource, config: Mapping[str, JsonValue], env: Mapping[str, str]
) -> AsyncGenerator[bytes, None]:
    stream = open_stream("envsubst", config)
    budget = YieldBudget()

    async def progress(output: bytes) -> AsyncGenerator[bytes, None]:
        while True:
            if output:
                yield output
            await budget.run()
            if stream.busy():
                output = stream.drain()
                continue
            request = stream.request()
            if request is None:
                return
            header, _ = request
            names = header.get("names")
            if (
                header.get("op") != "env"
                or not isinstance(names, list)
                or not all(isinstance(name, str) for name in names)
            ):
                raise ValueError("invalid environment binding request")
            values: dict[str, JsonValue] = {
                name: byte_view(env.get(name, ""))
                for name in names
                if isinstance(name, str)
            }
            output = stream.respond({"env": values}, b"")

    try:
        async with aclosing(chunks(source)) as bounded:
            async for chunk in bounded:
                async with aclosing(progress(stream.feed(chunk))) as output:
                    async for part in output:
                        yield part
        async with aclosing(progress(stream.finish())) as output:
            async for part in output:
                yield part
    finally:
        await close_stream(stream)


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
    env = {} if variables else dict(ctx.env or {})
    config: dict[str, JsonValue] = {
        "args": [byte_view(text) for text in texts],
        "variables": variables,
        "names": [byte_view(name) for name in env],
    }
    source = b"" if variables else resolve_source(ctx.stdin)
    return _substituted(source, config, env), IOResult()
