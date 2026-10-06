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

from mirage.commands.builtin.grep_offsets import (
    MatchOffsets,
    line_offsets,
    prefix_of,
    rg_pieces,
    rust_matches,
)
from mirage.commands.builtin.utils.pcre import match_start, match_text
from mirage.io.types import IOResult


def grep_lines(
    path: str,
    data: list[str],
    compiled: re.Pattern[str],
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    only_matching: bool,
    max_count: int | None,
    io: IOResult | None = None,
    byte_offsets: bool = False,
    pieces: bool = False,
) -> list[str]:
    """Grep one already-read input, returning the lines to print.

    Args:
        path (str): the operand's path, which -l answers with.
        data (list[str]): the input's lines, without terminators.
        compiled (re.Pattern[str]): the compiled pattern.
        invert (bool): -v, select the lines that do not match.
        line_numbers (bool): -n, prefix each printed line with its
            number.
        count_only (bool): -c, answer with the number of selected lines.
        files_only (bool): -l, answer with the path when anything was
            selected.
        only_matching (bool): -o, print the matched text rather than the
            line.
        max_count (int | None): -m, stop after this many selected lines;
            zero selects none at all, as GNU's does.
        io (IOResult | None): when given, receives exit status 0 as soon
            as a line is selected. Selection cannot be read off the
            returned list under -o, because GNU prints nothing for a
            zero-width match and still counts the line, so a caller
            deriving the status from an empty list reports 1 where GNU
            says 0.
        byte_offsets (bool): -b, prefix each printed line with the byte
            offset of its own start, or of the match itself under -o.
            The offsets are derived from the lines because this scan is
            handed text rather than bytes, which is exact only for text
            that came through ``decode_text``.
        pieces (bool): ripgrep's -o, which prints a line with no match
            whole (an inverted selection), prints empty matches, and
            counts matches under -c; see ``rg_pieces``.

    Returns:
        list[str]: the lines to print, the count under -c, or the path
            under -l.
    """
    if max_count == 0:
        # GNU selects no line at all and the whole command goes quiet:
        # `grep -m0 -c a f` prints NOTHING, not `0`, and exits 1. An empty
        # list is what -c has to answer with, because a caller such as
        # chroma's grep renders `<file>:<count>` from whatever comes back
        # and GNU prints no per-file zeros under -m0 either. Read before
        # the loop rather than after a line is printed, because
        # `count >= 0` is already true and the bottom check would let the
        # first selected line out first. `grep_input` takes the same early
        # return.
        return []
    results: list[str] = []
    count = 0
    rg_only = only_matching and pieces
    # ripgrep's -o -c counts matches, not the lines that hold them.
    matches = 0
    offsets = line_offsets(data) if byte_offsets else []
    for i, line in enumerate(data, 1):
        start = offsets[i - 1] if byte_offsets else 0
        m = compiled.search(line)
        matched = bool(m) != invert
        if not matched:
            continue
        count += 1
        if io is not None:
            io.exit_code = 0
        if count_only and rg_only:
            matches += len(rust_matches(compiled, line))
        if not count_only and not files_only:
            if rg_only:
                piece_offsets = (
                    MatchOffsets(start, line) if byte_offsets else None
                )
                for at, text in rg_pieces(compiled, line):
                    results.append(
                        prefix_of(
                            i if line_numbers else None,
                            piece_offsets.at(at) if piece_offsets else None,
                        )
                        + text
                    )
            elif only_matching:
                # GNU -o prints every match on the line, one per line, and
                # prints nothing at all for an empty match nor for an
                # inverted selection, which has no match to print
                # (`grep -ov abc` is zero bytes and exit 0 where GNU's own
                # -c still says 1). The line is still selected, so `count`
                # is already incremented above and -c, -l and the exit
                # status see it.
                if not invert:
                    match_offsets = (
                        MatchOffsets(start, line) if byte_offsets else None
                    )
                    for found in compiled.finditer(line):
                        text = match_text(found)
                        if not text:
                            continue
                        results.append(
                            prefix_of(
                                i if line_numbers else None,
                                match_offsets.at(match_start(found))
                                if match_offsets
                                else None,
                            )
                            + text
                        )
            else:
                results.append(
                    prefix_of(
                        i if line_numbers else None,
                        start if byte_offsets else None,
                    )
                    + line
                )
        if max_count is not None and count >= max_count:
            break
    if count_only:
        return [str(matches if rg_only else count)]
    if files_only:
        return [path] if count > 0 else []
    return results


def exit_code_for(matched: bool, failed: bool, quiet: bool) -> int:
    """The exit status grep and ripgrep share.

    An operand the search could not read is exit 2, and it outranks a
    match: both tools print the lines they did find and still exit 2. The
    one exception is grep's -q, documented as exiting zero when a match is
    found "even if an error was detected". Everything else is the familiar
    0 for a match, 1 for none.

    Args:
        matched (bool): True when any line was selected.
        failed (bool): True when an operand could not be searched.
        quiet (bool): True if -q is set; ripgrep passes False.

    Returns:
        int: the exit code.
    """
    if matched and quiet:
        return 0
    if failed:
        return 2
    return 0 if matched else 1
