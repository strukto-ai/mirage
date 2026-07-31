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


def jq_eval(obj: object, expr: str) -> list[object]:
    """Evaluate a jq expression against obj using libjq.

    A jq program is a stream transformer: it emits zero, one or many
    values, and jq prints each on its own line. That arity is preserved
    here rather than collapsed, so two outputs are never confused with
    one output that happens to be an array. `.a, .b` yields two values;
    `[.a, .b]` yields one.

    Args:
        obj (object): JSON-like input value (dict / list / scalar).
        expr (str): jq program text.

    Returns:
        list[object]: every output value, in order. Empty when the
            program produces no output at all, which real jq reports as
            exit 0 with empty stdout.
    """
    program = _libjq.compile(expr)
    return list(program.input_value(obj))
