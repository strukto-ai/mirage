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

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

DEFAULT_INDENT = 2

# The named argument the `inputs` prelude reads. Spelled so a user
# program can never collide with it by accident.
INPUTS_VAR = "__mirage_jq_inputs"

# The named argument the `$ARGS` prelude rebinds.
ARGS_VAR = "__mirage_jq_args"

# The record separator an application/json-seq stream puts before every
# value (RFC 7464).
RS = "\x1e"


@dataclass(frozen=True, slots=True)
class JqOptions:
    """One jq invocation's resolved options.

    The command line's implications are already applied by the caller
    (``-j`` and ``--raw-output0`` imply ``-r``, ``--tab`` and
    ``--indent`` resolve into one indent width), so every consumer reads
    plain fields.

    Args:
        null_input (bool): -n, run the program once against null and
            never read the inputs as the program's input.
        raw_input (bool): -R, each input line is a string instead of a
            JSON document.
        slurp (bool): -s, collapse the whole input stream into one
            value (an array of documents, or one string under -R).
        stream (bool): --stream, replace each input document with its
            [path, leaf] events, the same ones `tostream` emits.
        seq (bool): --seq, read and write RFC 7464 JSON text sequences
            (every value preceded by RS).
        raw_output (bool): -r, print a string output unquoted.
        join_output (bool): -j, write no separator after an output.
        nul_output (bool): --raw-output0, write a NUL after an output.
        compact (bool): -c, one line of JSON per output.
        ascii_output (bool): -a, escape every non-ASCII character. jq
            prints strings quoted under -a even with -r.
        sort_keys (bool): -S, sort object keys.
        tab (bool): indent with one tab per level.
        indent (int): spaces per indent level when not compact.
        exit_status (bool): -e, derive the exit code from the last
            output value.
        named_args (Mapping[str, Any]): --arg / --argjson / --rawfile /
            --slurpfile bindings, as the values $name resolves to.
        positional_args (tuple[Any, ...]): --args / --jsonargs values, in
            order, as $ARGS.positional reports them.
    """

    null_input: bool = False
    raw_input: bool = False
    slurp: bool = False
    stream: bool = False
    seq: bool = False
    raw_output: bool = False
    join_output: bool = False
    nul_output: bool = False
    compact: bool = False
    ascii_output: bool = False
    sort_keys: bool = False
    tab: bool = False
    indent: int = DEFAULT_INDENT
    exit_status: bool = False
    named_args: Mapping[str, Any] = field(default_factory=dict)
    positional_args: tuple[Any, ...] = ()
