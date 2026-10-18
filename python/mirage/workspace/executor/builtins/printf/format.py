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

from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import open_stream
from mirage.shell.bytes import encode_text


async def run_printf(
    fmt: str,
    args: list[str],
    program: bool = False,
    posix: bool = False,
    utf8: bool = False,
) -> tuple[bytes, bytes, int, bool]:
    """Format raw shell arguments through the shared bounded engine.

    Args:
        fmt (str): Format text, including shell byte escapes.
        args (list[str]): Raw argument text.
        program (bool): Use the program's numeric diagnostics.
        posix (bool): Suppress program character-constant warnings.
        utf8 (bool): Read quoted numeric constants as UTF-8 characters.
    """
    stream = open_stream(
        "printf",
        {
            "mode": "program" if program else "builtin",
            "posix": posix,
            "argument_count": len(args),
            "utf8": utf8,
        },
    )
    budget = YieldBudget()
    for index, text in enumerate([fmt, *args]):
        for at in range(0, len(text), 4096):
            stream.feed_input(index, encode_text(text[at : at + 4096]))
            await budget.run()
        stream.end_input(index)
        await budget.run()
    output = [stream.finish()]
    errors = [stream.take_stderr()]
    while stream.busy():
        output.append(stream.drain())
        errors.append(stream.take_stderr())
        await budget.run()
    return b"".join(output), b"".join(errors), stream.status(), stream.done()
