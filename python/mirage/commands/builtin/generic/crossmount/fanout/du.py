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

from collections.abc import Sequence

from mirage.commands.builtin.generic.crossmount.types import OperandRun
from mirage.commands.builtin.utils.formatting import _human_size


def _format_size(size: int, human: bool) -> str:
    return _human_size(size) if human else str(size)


def _humanize_row(line: str) -> str:
    size_text, tab, label = line.partition("\t")
    if not tab:
        return line
    return _human_size(int(size_text)) + "\t" + label


def merge_du_totals(blocks: Sequence[bytes], human: bool) -> bytes:
    """Strip each block's own total row and emit one global total.

    GNU ``du -c`` prints exactly one grand total, whatever it walked
    (pinned on coreutils 9.7: ``du -c`` over a directory holding a mount
    reports the mounted filesystem's bytes inside the one total). mirage
    reaches that number by concatenating runs, so each run's own total
    row (always its last) is removed here and the values re-summed.

    The callers force the runs to report exact bytes even under ``-h``,
    and the sizes are humanized here instead. Summing already-humanized
    totals would round twice, so two 1500-byte operands read back as 1536
    each and report ``3.0K`` where one mount says ``2.9K``. Per-run totals
    cannot be replaced by summing the rows either: without ``-a`` a run
    prints a row per directory, and those nest.

    Args:
        blocks (Sequence[bytes]): rendered du output, one per run.
        human (bool): Format the sizes like ``du -h`` does.
    """
    kept: list[str] = []
    total = 0
    for data in blocks:
        body = data.decode(errors="replace").splitlines()
        if body and body[-1].endswith("\ttotal"):
            total += int(body[-1].rsplit("\t", 1)[0])
            body = body[:-1]
        kept.extend(_humanize_row(line) if human else line for line in body)
    kept.append(_format_size(total, human) + "\ttotal")
    return ("\n".join(kept) + "\n").encode()


def du_total(results: list[OperandRun], human: bool) -> bytes:
    """Re-total a per-operand fan-out, one native run per operand.

    Every native run receives ``-c`` so glob operands total natively.

    Args:
        results (list[OperandRun]): Per-operand native du runs.
        human (bool): Format the sizes like ``du -h`` does.
    """
    return merge_du_totals([run.data for run in results], human)
