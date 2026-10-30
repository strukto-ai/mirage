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

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass

_REPETITION = re.compile(r"\{[0-9]*(,[0-9]*)?\}")


@dataclass(frozen=True, slots=True)
class RgFlags:
    """Normalized rg options, mirrored by TypeScript's RgFlags.

    parse_flags resolves mutually overriding options in command-line order.
    max_depth counts children at depth 1. null terminates filenames;
    null_data selects NUL-delimited records. type_changes preserves add/clear
    order; type_selections pairs each type name with an exclusion bit.
    threads is -j, None when the line left ripgrep to pick. text is -a,
    which turns binary detection off; binary is -a, --binary or -uuu,
    which also searches the files a walk would skip as binary. encoding is
    -E: auto, none, or the WHATWG name of the encoding a label named.
    """

    ignore_case: bool
    smart_case: bool
    invert: bool
    whole_word: bool
    line_regexp: bool
    fixed_string: bool
    line_numbers: bool
    column: bool
    vimgrep: bool
    byte_offsets: bool
    only_matching: bool
    replace: str | None
    trim: bool
    max_columns: int | None
    max_columns_preview: bool
    null: bool
    path_separator: str | None
    quiet: bool
    count_only: bool
    count_matches: bool
    include_zero: bool
    files_only: bool
    files_without_match: bool
    list_files: bool
    type_list: bool
    with_filename: bool
    no_filename: bool
    heading: bool
    passthru: bool
    max_count: int | None
    stop_on_nonmatch: bool
    context_after: int
    context_before: int
    context_separator: str | None
    field_match_separator: str
    field_context_separator: str
    globs: tuple[str, ...]
    iglobs: tuple[str, ...]
    glob_case_insensitive: bool
    type_changes: tuple[tuple[str, str], ...]
    type_selections: tuple[tuple[str, bool], ...]
    hidden: bool
    max_depth: int | None
    max_filesize: int | None
    follow: bool
    one_file_system: bool
    binary: bool
    sort: str | None
    sort_reverse: bool
    no_messages: bool
    null_data: bool = False
    crlf: bool = False
    multiline: bool = False
    multiline_dotall: bool = False
    stats: bool = False
    json: bool = False
    search_zip: bool = False
    pre: str | None = None
    pre_globs: tuple[str, ...] = ()
    engine: str = "default"
    threads: int | None = None
    text: bool = False
    unicode: bool = True
    encoding: str = "auto"


def record_end(f: RgFlags) -> bytes:
    """What ends a line rg writes itself, as opposed to a line it read:
    NUL under --null-data, CR LF under --crlf.

    Args:
        f (RgFlags): the parsed flags.
    """
    return b"\0" if f.null_data else b"\r\n" if f.crlf else b"\n"


def prints_context(f: RgFlags) -> bool:
    """Whether the output shows -A/-B/-C context, which also puts the
    context separator between one file's lines and the next file's.

    Only printed lines carry it: -c, -l and --files-without-match answer
    per file. -o keeps it, each line printed as its matches. --passthru
    prints every line but never separates groups.

    Args:
        f (RgFlags): the parsed flags.
    """
    if (
        f.count_only
        or f.count_matches
        or f.files_only
        or f.files_without_match
        or f.quiet
        or f.passthru
    ):
        return False
    return bool(f.context_before or f.context_after)


def _escape_literal(pattern: str, i: int) -> tuple[str | None, int]:
    """The literal a backslash escape at ``i`` stands for, if any.

    Args:
        pattern (str): the pattern.
        i (int): the index of the backslash.
    """
    if i + 1 >= len(pattern):
        return None, len(pattern)
    nxt = pattern[i + 1]
    if nxt in "pP":
        if i + 2 < len(pattern) and pattern[i + 2] == "{":
            close = pattern.find("}", i + 3)
            return None, len(pattern) if close == -1 else close + 1
        return None, i + 3
    if nxt == "x":
        if i + 2 < len(pattern) and pattern[i + 2] == "{":
            close = pattern.find("}", i + 3)
            digits = pattern[i + 3 : close] if close != -1 else ""
            end = len(pattern) if close == -1 else close + 1
        else:
            digits = pattern[i + 2 : i + 4]
            end = i + 4
        try:
            return chr(int(digits, 16)), end
        except ValueError:
            return None, end
    if nxt.isalnum():
        return None, i + 2
    return nxt, i + 2


def _regex_literals(pattern: str) -> Iterator[str]:
    """The literal characters of one ripgrep pattern, which is all smart
    case looks at: class members and escaped punctuation count, while
    escapes like ``\\w``, repetition counts, group syntax and POSIX class
    names do not.

    Args:
        pattern (str): one pattern of the list.
    """
    i = 0
    in_class = False
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\":
            literal, i = _escape_literal(pattern, i)
            if literal is not None:
                yield literal
            continue
        if in_class:
            if ch == "]":
                in_class = False
                i += 1
            elif pattern.startswith("[:", i):
                close = pattern.find(":]", i + 2)
                i = i + 1 if close == -1 else close + 2
            else:
                if ch != "-":
                    yield ch
                i += 1
            continue
        if ch == "[":
            in_class = True
            i += 1
            if i < len(pattern) and pattern[i] == "^":
                i += 1
            if i < len(pattern) and pattern[i] == "]":
                yield "]"
                i += 1
            continue
        if pattern.startswith("(?", i):
            j = i + 2
            if pattern.startswith("P<", j) or (
                pattern.startswith("<", j)
                and not pattern.startswith(("<=", "<!"), j)
            ):
                close = pattern.find(">", j)
                i = len(pattern) if close == -1 else close + 1
                continue
            while j < len(pattern) and pattern[j] not in ":)":
                j += 1
            i = j + 1 if j < len(pattern) and pattern[j] == ":" else j
            continue
        if ch == "{":
            rep = _REPETITION.match(pattern, i)
            if rep is not None:
                i = rep.end()
                continue
        if ch not in ".^$*+?()|{":
            yield ch
        i += 1


def smart_case_folds(pattern: str, fixed_string: bool) -> bool:
    """Whether -S searches ``pattern`` without regard to case: it has at
    least one literal character and none of them is uppercase.

    Args:
        pattern (str): the newline-joined pattern list.
        fixed_string (bool): -F, where every character is a literal.
    """
    found = False
    for part in pattern.split("\n"):
        for ch in part if fixed_string else _regex_literals(part):
            found = True
            if ch.isupper():
                return False
    return found


def folds_case(pattern: str, fixed: bool, f: RgFlags) -> bool:
    """Whether the search ignores case: -i, or -S over a pattern with no
    uppercase literal in it.

    Args:
        pattern (str): the newline-joined pattern list.
        fixed (bool): the patterns are literals (-F).
        f (RgFlags): the parsed flags.
    """
    return f.ignore_case or (f.smart_case and smart_case_folds(pattern, fixed))


@dataclass(slots=True)
class Tally:
    """What one haystack's search selected, beside what it printed.

    Args:
        selected (bool): a line was selected.
        binary (bool): a binary-file notice stood in for the lines.
        skipped (bool): a walked binary file went unsearched, which no
            listing names but --files-without-match's status counts.
        matches (int): the matches in the selected lines, counted for
            --stats and --json.
        matched_lines (int): the selected lines, counted for them.
        searched (int): the bytes read before the search stopped.
        nul (int | None): the first NUL's offset, a binary file's.
        error (str | None): what ended the search early, in ripgrep's
            words: a -P search that gave up at the backtracking limit.
    """

    selected: bool = False
    binary: bool = False
    skipped: bool = False
    matches: int = 0
    matched_lines: int = 0
    searched: int = 0
    nul: int | None = None
    error: str | None = None


@dataclass(slots=True)
class Totals:
    """What --stats and the --json summary add up over the haystacks.

    Args:
        matches (int): matches in the selected lines.
        matched_lines (int): selected lines.
        with_match (int): haystacks a line was selected in.
        searched (int): haystacks searched.
        printed (int): bytes printed for them.
        bytes_searched (int): bytes read from them.
        elapsed (float): seconds spent searching them.
    """

    matches: int = 0
    matched_lines: int = 0
    with_match: int = 0
    searched: int = 0
    printed: int = 0
    bytes_searched: int = 0
    elapsed: float = 0.0

    def merge(self, other: "Totals") -> None:
        """Add another run's totals: a line split over mounts prints one
        footer for all its runs.

        Args:
            other (Totals): the run's totals.
        """
        self.matches += other.matches
        self.matched_lines += other.matched_lines
        self.with_match += other.with_match
        self.searched += other.searched
        self.printed += other.printed
        self.bytes_searched += other.bytes_searched
        self.elapsed += other.elapsed

    def add(self, tally: Tally, printed: int, elapsed: float) -> None:
        """Count one haystack.

        Args:
            tally (Tally): its tally.
            printed (int): the bytes printed for it.
            elapsed (float): the seconds its search took.
        """
        self.matches += tally.matches
        self.matched_lines += tally.matched_lines
        self.with_match += int(tally.selected)
        self.searched += 1
        self.printed += printed
        self.bytes_searched += tally.searched
        self.elapsed += elapsed


STATS_ROWS = (
    "matches",
    "matched lines",
    "files contained matches",
    "files searched",
    "bytes printed",
    "bytes searched",
    "seconds spent searching",
    "seconds",
)


def split_footer(data: bytes, summary: bool) -> tuple[bytes, Totals | None]:
    """One run's output with the footer it ends with cut off, and the
    totals that footer printed, read back the way the wc and du combiners
    read their total rows; the output whole and None when it ends in none.

    Args:
        data (bytes): the run's output.
        summary (bool): the footer is --json's summary record, not the
            --stats block.
    """
    if summary:
        head, _, last = data[:-1].rpartition(b"\n")
        if not (
            data.endswith(b"\n")
            and last.startswith(b'{"data":')
            and last.endswith(b'"type":"summary"}')
        ):
            return data, None
        stats = json.loads(last)["data"]["stats"]
        return data[: len(data) - len(last) - 1], Totals(
            matches=stats["matches"],
            matched_lines=stats["matched_lines"],
            with_match=stats["searches_with_match"],
            searched=stats["searches"],
            printed=stats["bytes_printed"],
            bytes_searched=stats["bytes_searched"],
            elapsed=stats["elapsed"]["secs"]
            + stats["elapsed"]["nanos"] / 1_000_000_000,
        )
    rows = data.rsplit(b"\n", len(STATS_ROWS) + 1)
    if (
        len(rows) != len(STATS_ROWS) + 2
        or rows[-1]
        or rows[0][-1:]
        not in (
            b"",
            b"\n",
        )
    ):
        return data, None
    values: list[str] = []
    for row, label in zip(rows[1:-1], STATS_ROWS, strict=True):
        value, _, name = row.decode().partition(" ")
        if name != label:
            return data, None
        values.append(value)
    numbers = [int(v) for v in values[:6]]
    return rows[0], Totals(
        matches=numbers[0],
        matched_lines=numbers[1],
        with_match=numbers[2],
        searched=numbers[3],
        printed=numbers[4],
        bytes_searched=numbers[5],
        elapsed=float(values[6]),
    )
