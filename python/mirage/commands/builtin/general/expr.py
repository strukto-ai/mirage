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

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _expr_eval(args: tuple[str, ...]) -> tuple[str, int]:
    if len(args) == 3 and args[1] == ":":
        pattern = args[2]
        m = re.match(pattern, args[0])
        if m:
            result = m.group(1) if m.lastindex else str(m.end())
        else:
            result = ""
        exit_code = 1 if result == "" or result == "0" else 0
        return result, exit_code
    if len(args) == 3 and args[1] in ("+", "-", "*", "/", "%"):
        try:
            a, b = int(args[0]), int(args[2])
        except ValueError:
            return "", 2
        op = args[1]
        if op == "+":
            val = a + b
        elif op == "-":
            val = a - b
        elif op == "*":
            val = a * b
        elif op == "/":
            val = a // b
        else:
            val = a % b
        result = str(val)
        exit_code = 1 if result == "0" else 0
        return result, exit_code
    if len(args) == 3 and args[1] in ("=", "!=", "<", ">", "<=", ">="):
        left, op, right = args[0], args[1], args[2]
        try:
            l_val, r_val = int(left), int(right)
            numeric = True
        except ValueError:
            l_val, r_val = 0, 0
            numeric = False
        if numeric:
            cmp_map = {
                "=": l_val == r_val,
                "!=": l_val != r_val,
                "<": l_val < r_val,
                ">": l_val > r_val,
                "<=": l_val <= r_val,
                ">=": l_val >= r_val,
            }
        else:
            cmp_map = {
                "=": left == right,
                "!=": left != right,
                "<": left < right,
                ">": left > right,
                "<=": left <= right,
                ">=": left >= right,
            }
        val = 1 if cmp_map[op] else 0
        result = str(val)
        exit_code = 1 if result == "0" else 0
        return result, exit_code
    return "", 2


@command("expr", resource=None, spec=SPECS["expr"], provision=pure_provision)
async def expr(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        return b"\n", IOResult(exit_code=2)
    result, exit_code = _expr_eval(texts)
    return (result + "\n").encode(), IOResult(exit_code=exit_code)
