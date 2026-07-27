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

import jq as _libjq

from mirage.core.jq.format import JQ_EMPTY


def has_top_level_spread(expr: str) -> bool:
    """Report whether a jq program spreads its input at the top level.

    A top-level ``[]`` means the program emits one output per element,
    so the caller must print each on its own line. A ``[]`` nested
    inside a collector (``[.a[] | .b]``) does not: that program emits a
    single array. Strings are skipped so a literal "[]" never counts.

    Args:
        expr (str): jq program text.
    """
    depth = 0
    in_str = False
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch == '"' and (i == 0 or expr[i - 1] != "\\"):
            in_str = not in_str
            i += 1
            continue
        if in_str:
            i += 1
            continue
        if (depth == 0 and ch == "[" and i + 1 < len(expr)
                and expr[i + 1] == "]"):
            return True
        if ch in ("(", "[", "{"):
            depth += 1
        elif ch in (")", "]", "}"):
            depth -= 1
        i += 1
    return False


def jq_eval(obj: object, expr: str) -> object:
    """Evaluate a jq expression against obj using libjq.

    Args:
        obj (object): JSON-like input value (dict / list / scalar).
        expr (str): jq program text.

    Returns:
        object: single value when the program produces one output,
            list of values when it produces more than one,
            JQ_EMPTY sentinel when the program produces zero outputs.
            Callers must check `result is JQ_EMPTY` and treat that
            as "no output" (real jq exits 0 with empty stdout).
    """
    program = _libjq.compile(expr)
    outputs = list(program.input_value(obj))
    if not outputs:
        return JQ_EMPTY
    if len(outputs) == 1 and not has_top_level_spread(expr):
        return outputs[0]
    return outputs
