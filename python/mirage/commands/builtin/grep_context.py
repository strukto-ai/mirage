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

from mirage.commands.builtin.grep_offsets import (encode_line, line_offsets,
                                                  prefix_of)

_SEPARATOR = b"--\n"


def grep_context_lines(
    lines: list[str],
    pat: re.Pattern[str],
    invert: bool,
    line_numbers: bool,
    max_count: int | None,
    after_context: int,
    before_context: int,
    byte_offsets: bool = False,
) -> list[bytes]:
    """Render selected lines with their context, GNU's separators included.

    Args:
        lines (list[str]): the whole input, terminators stripped.
        pat (re.Pattern[str]): the compiled pattern.
        invert (bool): -v, select the lines that do not match.
        line_numbers (bool): -n, prefix each line with its number.
        max_count (int | None): -m, stop after this many selected lines.
        after_context (int): -A, trailing context lines.
        before_context (int): -B, leading context lines.
        byte_offsets (bool): -b, prefix each line with the byte offset of
            its own start. A context line renders it with ``-`` like
            every other field, and the ``--`` group separator carries no
            fields at all. The offsets are derived from the lines because
            this renderer is handed text rather than bytes, which is
            exact only for text that came through ``decode_line`` -- so
            that is what a caller must hand over. The rendered line is
            put back with ``encode_line``, so a byte that is not valid
            UTF-8 prints as GNU prints it rather than as U+FFFD.
    """
    if max_count == 0:
        # GNU selects no line at all under -m0, context and all, so there
        # is nothing to group and nothing to print. Read before the scan
        # because `len(match_indices) >= 0` is already true, so the check
        # below would keep the first selected line. `grep_input` and both
        # scans in `grep_scan` take the same early return.
        return []
    total = len(lines)
    offsets = line_offsets(lines) if byte_offsets else []
    match_indices: list[int] = []
    for idx, line in enumerate(lines):
        hit = bool(pat.search(line))
        if invert:
            hit = not hit
        if hit:
            match_indices.append(idx)
            if max_count is not None and len(match_indices) >= max_count:
                break

    if not match_indices:
        return []

    printed: set[int] = set()
    groups: list[list[int]] = []
    current_group: list[int] = []

    for mi in match_indices:
        start = max(0, mi - before_context)
        end = min(total - 1, mi + after_context)
        line_range = list(range(start, end + 1))
        if current_group and line_range[0] <= current_group[-1] + 1:
            for ln in line_range:
                if ln not in printed:
                    current_group.append(ln)
                    printed.add(ln)
        else:
            if current_group:
                groups.append(current_group)
            current_group = []
            for ln in line_range:
                printed.add(ln)
                current_group.append(ln)
    if current_group:
        groups.append(current_group)

    match_set = set(match_indices)
    result: list[bytes] = []
    for gi, group in enumerate(groups):
        if gi > 0:
            result.append(_SEPARATOR)
        for ln in group:
            line = lines[ln]
            fields = prefix_of(ln + 1 if line_numbers else None,
                               offsets[ln] if byte_offsets else None, ln
                               in match_set)
            result.append(encode_line(f"{fields}{line}\n"))
    return result
