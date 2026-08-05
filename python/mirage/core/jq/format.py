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

import orjson

from mirage.core.jq.types import DEFAULT_INDENT, RS, JqOptions

NUL = b"\x00"
NEWLINE = b"\n"
RS_BYTES = RS.encode()


def _dumps(value: object, opts: JqOptions) -> bytes:
    """Serialize one output value the way jq's dumper would.

    orjson serves the two shapes it can express (compact and the default
    two-space indent, either one with sorted keys); a tab, another
    width, or ASCII escaping falls back to the stdlib encoder, which
    renders numbers and separators identically.

    Args:
        value (object): the value to render.
        opts (JqOptions): resolved output options.
    """
    if not opts.ascii_output and not opts.tab and (opts.compact or opts.indent
                                                   == DEFAULT_INDENT):
        option = orjson.OPT_SORT_KEYS if opts.sort_keys else 0
        if not opts.compact:
            option |= orjson.OPT_INDENT_2
        return orjson.dumps(value, option=option)
    if opts.compact or opts.indent == 0:
        text = json.dumps(value,
                          ensure_ascii=opts.ascii_output,
                          sort_keys=opts.sort_keys,
                          separators=(",", ":"))
    else:
        text = json.dumps(value,
                          ensure_ascii=opts.ascii_output,
                          sort_keys=opts.sort_keys,
                          indent="\t" if opts.tab else " " * opts.indent)
    return text.encode()


def _terminator(opts: JqOptions) -> bytes:
    # --raw-output0 wins over -j whichever order they were typed, which
    # is what jq does.
    if opts.nul_output:
        return NUL
    return b"" if opts.join_output else NEWLINE


def format_one(value: object, opts: JqOptions) -> bytes:
    """Render one output value with its separator.

    Args:
        value (object): the value the program emitted.
        opts (JqOptions): resolved output options.
    """
    # -a beats -r: jq quotes and escapes a string under --ascii-output
    # even when raw output was asked for.
    if opts.raw_output and not opts.ascii_output and isinstance(value, str):
        body = value.encode()
    else:
        body = _dumps(value, opts)
    # RFC 7464 puts the separator before the value, not after it.
    prefix = RS_BYTES if opts.seq else b""
    return prefix + body + _terminator(opts)


def format_jq_output(outputs: list[object], opts: JqOptions) -> bytes:
    """Render every output of a jq program, one per line.

    Args:
        outputs (list[object]): values the program emitted, in order.
        opts (JqOptions): resolved output options.
    """
    return b"".join(format_one(value, opts) for value in outputs)
