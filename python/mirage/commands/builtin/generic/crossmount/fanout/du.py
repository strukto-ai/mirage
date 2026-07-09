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

from mirage.commands.builtin.generic.crossmount.types import OperandRun
from mirage.commands.builtin.utils.formatting import _human_size, parse_size


def _format_size(size: int, human: bool) -> str:
    return _human_size(size) if human else str(size)


def du_total(results: list[OperandRun], human: bool) -> bytes:
    """Strip each run's own total row and emit one global total.

    Every native run receives ``-c`` so glob operands total natively; the
    per-run totals (always the last row) are removed and re-summed.

    Args:
        results (list[OperandRun]): Per-operand native du runs.
        human (bool): Format the total like ``du -h`` does.
    """
    kept: list[bytes] = []
    total = 0
    for run in results:
        body = run.data.decode(errors="replace").splitlines()
        if body and body[-1].endswith("\ttotal"):
            total += parse_size(body[-1].rsplit("\t", 1)[0])
            body = body[:-1]
        if body:
            kept.append(("\n".join(body) + "\n").encode())
    kept.append((_format_size(total, human) + "\ttotal\n").encode())
    return b"".join(kept)
