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

import math
from typing import Any

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

_MATH_FUNCS = {
    "s": math.sin,
    "c": math.cos,
    "a": math.atan,
    "l": math.log,
    "e": math.exp,
    "sqrt": math.sqrt,
}

_SAFE_BUILTINS: dict[str, Any] = {"__builtins__": {}}


def _eval_bc(expression: str, use_math: bool) -> str:
    expr = expression.strip()
    if not expr:
        return ""
    ns = dict(_SAFE_BUILTINS)
    if use_math:
        ns.update(_MATH_FUNCS)
    expr = expr.replace("^", "**")
    result = eval(expr, ns)  # noqa: S307
    if isinstance(result, float) and result == int(result):
        return str(int(result))
    return str(result)


@command("bc", resource=None, spec=SPECS["bc"], provision=pure_provision)
async def bc(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: ByteSource | None = None,
    args_l: bool = False,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raw = b""
    lines = raw.decode(errors="replace").strip().splitlines()
    results: list[str] = []
    for line in lines:
        line = line.strip()
        if line:
            results.append(_eval_bc(line, args_l))
    if not results:
        return b"", IOResult()
    return ("\n".join(results) + "\n").encode(), IOResult()
