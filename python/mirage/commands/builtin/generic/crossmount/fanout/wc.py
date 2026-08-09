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
from mirage.commands.builtin.generic.wc import (WCCounts, format_count_rows,
                                                parse_flags)
from mirage.commands.spec.types import FlagValue


def _parse_wc_row(line: str, columns: int) -> tuple[list[int], str]:
    parts = line.split(None, columns)
    values = [int(v) for v in parts[:columns]]
    label = parts[columns] if len(parts) > columns else ""
    return values, label


def _wc_counts(values: list[int], *, lines: bool, words: bool, bytes_: bool,
               chars: bool, max_line_length: bool) -> WCCounts:
    if max_line_length:
        return WCCounts(max_line_length=values[0])
    if lines:
        return WCCounts(lines=values[0])
    if words:
        return WCCounts(words=values[0])
    if bytes_:
        return WCCounts(bytes_=values[0])
    if chars:
        return WCCounts(chars=values[0])
    return WCCounts(lines=values[0], words=values[1], bytes_=values[2])


def combine_wc(results: list[OperandRun],
               flag_kwargs: dict[str, FlagValue]) -> bytes:
    """Re-total per-operand wc rows with one shared column width.

    Each native run right-aligns its own rows against its own widest count,
    so the runs cannot simply concatenate: rows are re-parsed and the whole
    report is reformatted by the same formatter the single-mount command
    uses, which is also what applies ``--total``. ``run_fanout`` forces the
    native runs to ``--total=never``, so every line read here is a file row
    and the grand total below is the only one the report can carry.

    Args:
        results (list[OperandRun]): Per-operand native wc runs.
        flag_kwargs (dict): Flags parsed against the shared wc spec.
    """
    flags = parse_flags(flag_kwargs)
    sel = dict(lines=flags.lines,
               words=flags.words,
               bytes_=flags.bytes_,
               chars=flags.chars,
               max_line_length=flags.max_line_length)
    columns = 1 if any(sel.values()) else 3
    rows: list[tuple[WCCounts, str | None]] = []
    totals = WCCounts()
    for run in results:
        for line in run.data.decode(errors="replace").splitlines():
            values, label = _parse_wc_row(line, columns)
            counts = _wc_counts(values, **sel)
            rows.append((counts, label or None))
            totals.merge(counts)
    # GNU decides the auto total on the operands *given*, not on the rows
    # that resolved, so a missing operand still gets a total row. There are
    # always at least two scopes here, and a glob operand can expand to more.
    return format_count_rows(rows, totals, max(len(rows), len(results)), flags)
