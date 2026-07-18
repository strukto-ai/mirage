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
from mirage.commands.builtin.generic.wc import WCCounts, format_wc_lines
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView


def _parse_wc_row(line: str, columns: int) -> tuple[list[int], str]:
    parts = line.split(None, columns)
    values = [int(v) for v in parts[:columns]]
    label = parts[columns] if len(parts) > columns else ""
    return values, label


def _wc_counts(values: list[int], *, args_l: bool, w: bool, c: bool, m: bool,
               L: bool) -> WCCounts:
    if L:
        return WCCounts(max_line_length=values[0])
    if args_l:
        return WCCounts(lines=values[0])
    if w:
        return WCCounts(words=values[0])
    if c:
        return WCCounts(bytes_=values[0])
    if m:
        return WCCounts(chars=values[0])
    return WCCounts(lines=values[0], words=values[1], bytes_=values[2])


def combine_wc(results: list[OperandRun], flag_kwargs: dict[str,
                                                            object]) -> bytes:
    """Re-total per-operand wc rows with one shared column width.

    Each native run right-aligns its own rows, so the runs cannot simply
    concatenate: rows are re-parsed and the whole report (plus the global
    ``total`` row, where max line length maxes instead of summing) is
    reformatted by the same wc formatter the single-mount command uses.

    Args:
        results (list[OperandRun]): Per-operand native wc runs.
        flag_kwargs (dict): Flags parsed against the shared wc spec.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["wc"])
    sel = dict(args_l=fl.as_bool("args_l"),
               w=fl.as_bool("w"),
               c=fl.as_bool("c"),
               m=fl.as_bool("m"),
               L=fl.as_bool("L"))
    columns = 1 if any(sel.values()) else 3
    rows: list[tuple[WCCounts, str | None]] = []
    for run in results:
        body = run.data.decode(errors="replace").splitlines()
        if len(body) > 1:
            body = body[:-1]
        for line in body:
            values, label = _parse_wc_row(line, columns)
            rows.append((_wc_counts(values, **sel), label or None))
    if not rows:
        return b""
    total = WCCounts()
    for counts, _ in rows:
        total.merge(counts)
    lines = format_wc_lines(rows + [(total, "total")], **sel)
    return ("\n".join(lines) + "\n").encode()
