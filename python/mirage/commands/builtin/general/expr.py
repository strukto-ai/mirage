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
from mirage.commands.config import Context, command
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import close_stream, open_stream
from mirage.shell.bytes import byte_view, from_byte_view, utf8_locale
from mirage.types import PathSpec


async def _expr_eval(args: list[str], utf8: bool = False) -> tuple[str, int]:
    """Evaluate expression words through the shared core.

    Args:
        args (list[str]): Byte views, or text under a UTF-8 locale.
        utf8 (bool): Whether string operations count characters.
    """
    engine = open_stream(
        "expr",
        {
            "words": [byte_view(word) if utf8 else word for word in args],
            "utf8": utf8,
        },
    )
    budget = YieldBudget()
    out: list[bytes] = []
    try:
        while engine.busy():
            await budget.run()
            out.append(engine.drain())
        if engine.status() == 2:
            raise UsageError(
                byte_view(engine.take_stderr(), utf8).rstrip("\n")
            )
        return byte_view(b"".join(out), utf8), engine.status()
    finally:
        await close_stream(engine)


@command("expr", vfs=None, spec=SPECS["expr"])
async def expr(
    accessor: Accessor,
    paths: list[PathSpec] | None,
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    utf8 = utf8_locale(ctx.env)
    try:
        result, exit_code = await _expr_eval(
            [byte_view(t, utf8) for t in texts], utf8
        )
    except UsageError as exc:
        return None, IOResult(
            exit_code=2, stderr=from_byte_view(f"{exc}\n", utf8)
        )
    return from_byte_view(result + "\n", utf8), IOResult(exit_code=exit_code)
