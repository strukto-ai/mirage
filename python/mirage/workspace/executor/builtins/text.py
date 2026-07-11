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

from mirage.commands.spec.shell import ECHO_OPTION
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.types import ExecutionNode

_SIMPLE_ESCAPES = {
    "\\": "\\",
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "v": "\v",
}

_HEX = set("0123456789abcdefABCDEF")

_OCT = set("01234567")


def _interpret_escapes(text: str) -> str:
    """Process C-style escape sequences for echo -e.

    Single-pass to handle \\\\ correctly (\\\\b → \\b literal).
    Supports: \\\\, \\n, \\t, \\r, \\a, \\b, \\f, \\v,
    \\xHH (hex), \\0NNN (octal), \\c (stop output).
    Unknown escapes like \\z pass through as \\z.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] != "\\" or i + 1 >= n:
            out.append(text[i])
            i += 1
            continue
        ch = text[i + 1]
        if ch in _SIMPLE_ESCAPES:
            out.append(_SIMPLE_ESCAPES[ch])
            i += 2
        elif ch == "c":
            break
        elif ch == "x":
            # \xHH — up to 2 hex digits
            digits = []
            j = i + 2
            while j < n and len(digits) < 2 and text[j] in _HEX:
                digits.append(text[j])
                j += 1
            if digits:
                out.append(chr(int("".join(digits), 16)))
                i = j
            else:
                out.append("\\x")
                i += 2
        elif ch == "0":
            # \0NNN — up to 3 octal digits
            digits = []
            j = i + 2
            while j < n and len(digits) < 3 and text[j] in _OCT:
                digits.append(text[j])
                j += 1
            out.append(chr(int("".join(digits), 8)) if digits else "\0")
            i = j
        else:
            # unknown escape — pass through literally
            out.append("\\")
            out.append(ch)
            i += 2
    return "".join(out)


async def handle_echo(
        args: list[str],  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print arguments, honoring GNU echo's option rules.

    GNU echo is not getopt: options are LEADING words matching
    ``-[neE]+`` only. The first word that does not match (including
    ``-x`` or a repeated ``hi -n``) ends option parsing and prints
    literally. Within clusters the last of -e/-E wins; -n sticks.

    Args:
        args (list[str]): words after the command name, as typed.
    """
    no_newline = False
    escapes = False
    idx = 0
    for word in args:
        if not ECHO_OPTION.fullmatch(word):
            break
        for ch in word[1:]:
            if ch == "n":
                no_newline = True
            elif ch == "e":
                escapes = True
            else:
                escapes = False
        idx += 1
    text = " ".join(args[idx:])
    if escapes:
        text = _interpret_escapes(text)
    if not no_newline:
        text += "\n"
    out = text.encode()
    return out, IOResult(), ExecutionNode(command="echo", exit_code=0)


async def handle_printf(
        args: list[str],  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        return b"", IOResult(), ExecutionNode(command="printf", exit_code=0)
    fmt = args[0]
    fmt = fmt.replace("\\n", "\n").replace("\\t", "\t")
    if len(args) > 1:
        try:
            out = (fmt % tuple(args[1:])).encode()
        except TypeError:
            out = fmt.encode()
    else:
        out = fmt.encode()
    return out, IOResult(), ExecutionNode(command="printf", exit_code=0)
