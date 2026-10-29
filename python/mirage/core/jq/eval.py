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

import re

from mirage.core.jq.parse import string_text
from mirage.core.jq.types import JqOptions, StreamReads

INPUT_REF = re.compile(r"(?<![\w$.:])input(?![\w:])")
INPUTS_REF = re.compile(r"(?<![\w$.:])inputs(?![\w:])")
INPUT_DEF = re.compile(r"(?<![\w$.:])def\s+input\s*[:(]")
INPUTS_DEF = re.compile(r"(?<![\w$.:])def\s+inputs\s*[:(]")
ARGS_REF = re.compile(r"\$ARGS(?![\w:])")
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
INTERP = "\\("
OPENERS = "([{"
CLOSERS = ")]}"


def code_only(expr: str) -> str:
    """Blank out every part of a jq program that cannot be a call.

    Three things are replaced by spaces: string bodies, `#` comments,
    and the field names an object shorthand abbreviates (`{a, inputs}`
    is `{a: .a, inputs: .inputs}`). Interpolations stay code, because
    `"\\(inputs)"` really does call the builtin, so everything between
    `\\(` and its closing paren survives, nested strings included.

    Args:
        expr (str): jq program text.
    """
    out: list[str] = []
    # Open brackets, innermost last, with an interpolation recorded as
    # one too; empty means the scan is at the top level of the program.
    stack: list[str] = []
    in_string = False
    prev = ""
    i = 0
    while i < len(expr):
        ch = expr[i]
        if in_string:
            if ch == "\\" and i + 1 < len(expr):
                if expr[i + 1] == "(":
                    in_string = False
                    stack.append(INTERP)
                out.append("  ")
                i += 2
                continue
            in_string = ch != '"'
            out.append(" ")
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(" ")
            i += 1
            continue
        if ch == "#":
            while i < len(expr) and expr[i] != "\n":
                out.append(" ")
                i += 1
            continue
        word = IDENT.match(expr, i)
        if word is not None:
            text = word.group()
            key = bool(stack) and stack[-1] == "{" and prev in ("{", ",")
            out.append(" " * len(text) if key else text)
            prev = text[-1]
            i = word.end()
            continue
        if ch in OPENERS:
            stack.append(ch)
        elif ch == ")" and stack and stack[-1] == INTERP:
            stack.pop()
            in_string = True
            out.append(" ")
            prev = ""
            i += 1
            continue
        elif ch in CLOSERS and stack and stack[-1] != INTERP:
            stack.pop()
        out.append(ch)
        if not ch.isspace():
            prev = ch
        i += 1
    return "".join(out)


def references_args(expr: str) -> bool:
    """Report whether a jq program reads the `$ARGS` variable.

    Args:
        expr (str): jq program text.
    """
    return ARGS_REF.search(code_only(expr)) is not None


def args_text(opts: JqOptions) -> str:
    """The JSON text of the value `$ARGS` resolves to for a run.

    Args:
        opts (JqOptions): resolved options carrying both binding kinds.
    """
    positional = ",".join(opts.positional_args)
    named = ",".join(
        f"{string_text(name)}:{text}" for name, text in opts.named_args.items()
    )
    return f'{{"positional":[{positional}],"named":{{{named}}}}}'


def stream_reads(expr: str) -> StreamReads:
    """Report which of the builtins that read the input stream a program
    calls.

    Binding the unread documents is what makes `input` and `inputs`
    work, and it also changes how many documents a run consumes, so only
    the builtins may answer here: the words also spell a field
    (`.inputs`, `{inputs}`), a variable (`$inputs`), an object key
    (`{inputs: 1}`), a module member (`m::inputs`), a function the
    program defines for itself (`def input: ...`), and anything at all
    inside a string or a comment, none of which read the stream.

    Args:
        expr (str): jq program text.
    """
    code = code_only(expr)
    return StreamReads(
        input=INPUT_REF.search(code) is not None
        and INPUT_DEF.search(code) is None,
        inputs=INPUTS_REF.search(code) is not None
        and INPUTS_DEF.search(code) is None,
    )
