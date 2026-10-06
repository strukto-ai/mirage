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

import json
import logging
import re

import orjson

from mirage.core.jq.types import (
    DEFAULT_INDENT,
    RS,
    JqError,
    JqHalt,
    JqOptions,
    JqRun,
)
from mirage.errors.fs import fs_strerror

logger = logging.getLogger(__name__)

NUL = b"\x00"
NEWLINE = b"\n"
RS_BYTES = RS.encode()

# What jq's compact dump holds: strings, which are taken whole so the
# structure inside one stays text, the structure between values, and the
# literals, which are everything else. The dump has no whitespace outside
# a string.
STRUCTURE_TOKEN = re.compile(r'"[^"\\]*(?:\\.[^"\\]*)*"|[\[\]{},:]')
DUMP_TOKEN = re.compile(r'"[^"\\]*(?:\\.[^"\\]*)*"|[\[\]{},:]|[^\[\]{},:"]+')
NON_ASCII = re.compile(r"[^\x00-\x7f]")

# How jq's main loop fails a run whose output --raw-output0 cannot print.
NUL_REFUSAL = "Cannot dump a string containing NUL with --raw-output0 option"


def _escaped(match: re.Match[str]) -> str:
    # jq's -a writes one \uXXXX in lower case per UTF-16 code unit, so a
    # character past U+FFFF escapes as its surrogate pair.
    point = ord(match.group())
    if point < 0x10000:
        return f"\\u{point:04x}"
    point -= 0x10000
    high = 0xD800 | (point >> 10)
    low = 0xDC00 | (point & 0x3FF)
    return f"\\u{high:04x}\\u{low:04x}"


def _ascii(text: str) -> str:
    """jq's dump with every character past ASCII escaped (-a); only a
    string holds one.

    Args:
        text (str): jq's dump text.
    """
    return NON_ASCII.sub(_escaped, text)


def _key(text: str) -> str:
    # The key a member's dumped name spells, which -S orders by: code
    # points order as the UTF-8 bytes jq compares do.
    return text[1:-1] if "\\" not in text else json.loads(text)


def _sorted(text: str) -> str:
    """jq's compact dump with every object's keys sorted (-S).

    Built bottom up from the dump, one container at a time, so a value
    nested as deep as jq's parser allows needs no recursion.

    Args:
        text (str): jq's compact dump of one value.
    """
    # The open containers, innermost last: each one's opener, the names
    # of an object's members so far, and the values so far. An object
    # holding one more name than values is waiting for that name's value.
    openers: list[str] = []
    names: list[list[str]] = []
    values: list[list[str]] = []
    done = text
    for match in DUMP_TOKEN.finditer(text):
        token = match.group()
        first = token[0]
        if first in "[{":
            openers.append(first)
            names.append([])
            values.append([])
            continue
        if first in ",:":
            continue
        if first in "]}":
            openers.pop()
            keys = names.pop()
            items = values.pop()
            if first == "]":
                token = f"[{','.join(items)}]"
            else:
                ordered = sorted(
                    zip(keys, items), key=lambda member: _key(member[0])
                )
                token = (
                    "{"
                    + ",".join(f"{name}:{value}" for name, value in ordered)
                    + "}"
                )
        if not openers:
            done = token
        elif openers[-1] == "{" and len(names[-1]) == len(values[-1]):
            names[-1].append(token)
        else:
            values[-1].append(token)
    return done


def _indented(text: str, unit: str) -> str:
    """jq's pretty dump of a compact one (jv_dump_term with
    JV_PRINT_PRETTY): each member on a line of its own, `unit` once per
    level, a space after each colon, and an empty array or object as
    `[]` or `{}`. A zero-width unit, --indent 0, still breaks the lines.

    Args:
        text (str): jq's compact dump of one value.
        unit (str): one level of indentation.
    """
    out: list[str] = []
    depth = 0
    last = 0
    empty = False
    for match in STRUCTURE_TOKEN.finditer(text):
        token = match.group()
        if token[0] == '"':
            continue
        start = match.start()
        out.append(text[last:start])
        last = match.end()
        if empty:
            out.append(token)
            empty = False
        elif token in "[{":
            if text.startswith(("]", "}"), last):
                out.append(token)
                empty = True
                continue
            depth += 1
            out.append(f"{token}\n{unit * depth}")
        elif token in "]}":
            depth -= 1
            out.append(f"\n{unit * depth}{token}")
        elif token == ",":
            out.append(f",\n{unit * depth}")
        else:
            out.append(": ")
    out.append(text[last:])
    return "".join(out)


def _through_orjson(text: str, opts: JqOptions) -> str | None:
    """The layouts orjson writes the way jv_dump_term does, compact or two
    spaces deep, sorted or not, with each number kept as the text jq
    dumped it in, and DEL escaped as jq escapes it; None for a value
    nested deeper than orjson writes.

    Args:
        text (str): jq's compact dump of one value.
        opts (JqOptions): resolved output options.
    """
    option = orjson.OPT_SORT_KEYS if opts.sort_keys else 0
    if not opts.compact:
        option |= orjson.OPT_INDENT_2
    try:
        tree = json.loads(
            text, parse_int=orjson.Fragment, parse_float=orjson.Fragment
        )
        dumped = orjson.dumps(tree, option=option)
    except (RecursionError, orjson.JSONEncodeError) as exc:
        logger.debug("jq: output past orjson, laid out by hand: %s", exc)
        return None
    return dumped.decode().replace("\x7f", "\\u007f")


def _laid_out(text: str, opts: JqOptions) -> str:
    """jq's compact dump laid out for -S, -c, --tab and --indent.

    Args:
        text (str): jq's compact dump of one value.
        opts (JqOptions): resolved output options.
    """
    if opts.compact or (not opts.tab and opts.indent == DEFAULT_INDENT):
        fast = _through_orjson(text, opts)
        if fast is not None:
            return fast
    if opts.sort_keys:
        text = _sorted(text)
    if not opts.compact:
        text = _indented(text, "\t" if opts.tab else " " * opts.indent)
    return text


def dump_text(text: str, opts: JqOptions) -> str:
    """One output as jq's main loop dumps it: jq's own compact dump, laid
    out for -S, -c, --tab, --indent and -a the way jv_dump_term lays
    them out.

    Args:
        text (str): jq's compact dump of the output.
        opts (JqOptions): resolved output options.
    """
    if opts.sort_keys or not opts.compact:
        text = _laid_out(text, opts)
    return _ascii(text) if opts.ascii_output else text


def _terminator(opts: JqOptions) -> bytes:
    # --raw-output0 wins over -j whichever order they were typed, which
    # is what jq does.
    if opts.nul_output:
        return NUL
    return b"" if opts.join_output else NEWLINE


def format_one(text: str, opts: JqOptions) -> bytes:
    """Render one output with its separator.

    Args:
        text (str): jq's compact dump of the output.
        opts (JqOptions): resolved output options.
    """
    raw = opts.raw_output and text.startswith('"')
    # -a beats -r: jq writes a string quoted and escaped under
    # --ascii-output, dumped with that flag alone, even when raw output
    # was asked for.
    if raw and not opts.ascii_output:
        string: str = orjson.loads(text)
        body = string.encode()
    elif raw:
        body = _ascii(text).encode()
    else:
        body = dump_text(text, opts).encode()
    # RFC 7464 puts the separator before the value, not after it, and jq
    # writes none before a string it prints raw, quoted by -a or not.
    prefix = RS_BYTES if opts.seq and not raw else b""
    return prefix + body + _terminator(opts)


def format_jq_output(texts: list[str], opts: JqOptions) -> bytes:
    """Render every output of a jq program, one per line.

    Args:
        texts (list[str]): jq's compact dump of each output, in order.
        opts (JqOptions): resolved output options.
    """
    return b"".join(format_one(text, opts) for text in texts)


def printable(run: JqRun[str], opts: JqOptions) -> JqRun[str]:
    """The run as jq's main loop gets to print it: --raw-output0 refuses a
    raw string that holds a NUL, which ends the run with an error there,
    the outputs before it printed.

    Args:
        run (JqRun[str]): the run, its outputs jq's compact dumps.
        opts (JqOptions): resolved output options.
    """
    if not opts.nul_output or opts.ascii_output:
        return run
    for at, text in enumerate(run.outputs):
        if (
            text.startswith('"')
            and "\\u0000" in text
            and "\0" in orjson.loads(text)
        ):
            return JqRun(run.outputs[:at], JqError(NUL_REFUSAL, True))
    return run


def error_report(position: str, error: JqError) -> str:
    """jq's report of an error no `try` caught, which it writes to stderr.

    A string message is printed the way C prints a string, so it ends at
    a NUL.

    Args:
        position (str): where jq's reader stands.
        error (JqError): the error.
    """
    if error.string:
        text = error.text.split("\0", 1)[0]
        return f"jq: error (at {position}): {text}\n"
    return f"jq: error (at {position}) (not a string): {error.text}\n"


def load_failure(name: str, exc: BaseException) -> str:
    """Why jq could not load a whole file (jv_load_file): an -f program,
    a --rawfile or a --slurpfile. It opens the file itself, so a
    directory gets words of its own instead of a failed read.

    Args:
        name (str): the file as typed.
        exc (BaseException): why it could not be read.
    """
    if isinstance(exc, IsADirectoryError):
        return f"Could not open {name}: It's a directory"
    return f"Could not open {name}: {fs_strerror(exc)}"


def halt_report(halt: JqHalt) -> str:
    """What jq writes to stderr for a halt: a string as it is, anything
    else dumped on a line of its own, and nothing for `halt` or a null.

    Args:
        halt (JqHalt): the halt.
    """
    if halt.message is None:
        return ""
    return halt.message if halt.string else f"{halt.message}\n"
