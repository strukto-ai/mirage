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

import base64
import json
import re
from bisect import bisect_right
from collections import deque
from collections.abc import AsyncIterator, Iterable, Iterator
from dataclasses import dataclass, field

from mirage.commands.builtin.grep_prefilter import required_needles
from mirage.commands.builtin.utils.pcre import (
    match_start,
    match_text,
    user_groups,
)
from mirage.concurrency.worker import Worker
from mirage.core.render.json import compact_json_bytes
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import close_quietly, discard_streams
from mirage.io.yield_budget import YieldBudget
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.helpers import byte_offset
from mirage.types import JsonValue
from mirage.utils.encoding import BOMS, bom_of, decoder_for
from mirage.utils.regex import AsyncRegex, Pattern, RegexMatch, prepare

# ripgrep's words for a line -M will not print whole (ripgrep 14.1.1).
OMITTED_MATCHING = "[Omitted long matching line]"
OMITTED_CONTEXT = "[Omitted long context line]"
OMITTED_END = " [... omitted end of long line]"
# What --trim strips: ASCII whitespace, as ripgrep's trim_ascii_prefix.
ASCII_SPACE = " \t\n\x0b\x0c\r"
_CAP_LETTER = re.compile(r"[0-9A-Za-z_]+")
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


def read_line(raw: bytes, f: RgFlags) -> tuple[str, bool]:
    """One record's text, and whether --crlf took a CR off its end so
    that `$`, -x and -w see the line without it.

    Args:
        raw (bytes): the record, its terminator stripped.
        f (RgFlags): the parsed flags.
    """
    cr = f.crlf and raw.endswith(b"\r")
    return decode_text(raw[:-1] if cr else raw), cr


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


def rust_matches(pat: Pattern, text: str) -> Iterator[RegexMatch]:
    """Every match on a line in the order Rust's regex iterates them.

    After an empty match the search resumes one character on, and an
    empty match where the previous match ended is skipped: ``b*`` over
    ``abc`` is empty, ``b``, empty, where ``finditer`` also yields the
    empty match right after ``b``.

    Args:
        pat (Pattern): the compiled pattern.
        text (str): the line.
    """
    pos = 0
    last_end = -1
    while pos <= len(text):
        m = pat.search(text, pos)
        if m is None:
            return
        if m.start() == m.end() and m.end() == last_end:
            pos = m.end() + 1
            continue
        yield m
        last_end = m.end()
        pos = m.end() if m.end() > m.start() else m.end() + 1


def _capture_ref(rest: str) -> tuple[str | None, int]:
    """The group a ``$`` names at the start of ``rest``, and its length.

    Args:
        rest (str): the template from a ``$`` on.
    """
    if len(rest) <= 1:
        return None, 0
    if rest[1] == "{":
        close = rest.find("}", 2)
        if close == -1:
            return None, 0
        return rest[2:close], close + 1
    name = _CAP_LETTER.match(rest, 1)
    if name is None:
        return None, 0
    return name.group(0), name.end()


def _capture(m: RegexMatch, ref: str) -> str:
    """One group's text for a replacement, empty when there is none.

    Args:
        m (RegexMatch): the match.
        ref (str): a group number or name.
    """
    if ref.isascii() and ref.isdigit():
        number = int(ref)
        if number == 0:
            return match_text(m)
        groups = user_groups(m.re)
        if number > len(groups):
            return ""
        return m.group(groups[number - 1]) or ""
    try:
        return m.group(ref) or ""
    except IndexError:
        return ""


def expand(template: str, m: RegexMatch) -> str:
    """One match's -r replacement, expanded as Rust's ``Captures::expand``.

    ``$1``, ``${1}``, ``$name`` and ``${name}`` name a group, a name
    being the longest run of ``[0-9A-Za-z_]`` (so ``$1x`` is the group
    ``1x``), a group that did not take part is empty, ``$$`` is ``$``,
    and a ``$`` no name follows is itself.

    Args:
        template (str): the replacement as typed.
        m (RegexMatch): the match to expand it for.
    """
    out: list[str] = []
    i = 0
    while True:
        j = template.find("$", i)
        if j == -1:
            out.append(template[i:])
            return "".join(out)
        out.append(template[i:j])
        rest = template[j:]
        if rest.startswith("$$"):
            out.append("$")
            i = j + 2
            continue
        ref, length = _capture_ref(rest)
        if ref is None:
            out.append("$")
            i = j + 1
            continue
        out.append(_capture(m, ref))
        i = j + length


def replace_all(
    pat: Pattern, text: str, template: str
) -> tuple[str, list[tuple[int, int]]]:
    """The line with every match replaced, and where each replacement
    landed in it (character spans), which --vimgrep's columns and -M's
    preview count read.

    Args:
        pat (Pattern): the compiled pattern.
        text (str): the line.
        template (str): -r's replacement.
    """
    pieces: list[str] = []
    spans: list[tuple[int, int]] = []
    last = 0
    length = 0
    for m in rust_matches(pat, text):
        before = text[last : match_start(m)]
        pieces.append(before)
        length += len(before)
        replaced = expand(template, m)
        spans.append((length, length + len(replaced)))
        pieces.append(replaced)
        length += len(replaced)
        last = m.end()
    pieces.append(text[last:])
    return "".join(pieces), spans


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


def _byte_len(text: str) -> int:
    return len(encode_text(text))


class ByteCursor:
    """Byte offsets of ever later positions in one line, each counted on
    from the one before, so a line's matches cost one pass over it
    rather than one per match.

    Args:
        text (str): the line, from ``decode_text``.
    """

    def __init__(self, text: str) -> None:
        self._text = text
        self._index = 0
        self._offset = 0

    def at(self, index: int) -> int:
        """The byte offset of a code-point index, no earlier than the last
        one asked for.

        Args:
            index (int): a code-point index into the line.
        """
        self._offset += _byte_len(self._text[self._index : index])
        self._index = index
        return self._offset


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
    """

    selected: bool = False
    binary: bool = False
    skipped: bool = False
    matches: int = 0
    matched_lines: int = 0
    searched: int = 0
    nul: int | None = None


def duration(seconds: float, ordered: bool = False) -> JsonValue:
    """A span of time as ripgrep's JSON writes it.

    Args:
        seconds (float): the span.
        ordered (bool): keys sorted, as the summary record has them.
    """
    total = int(seconds * 1_000_000_000)
    secs, nanos = divmod(total, 1_000_000_000)
    human = f"{seconds:.6f}s"
    if ordered:
        return {"human": human, "nanos": nanos, "secs": secs}
    return {"secs": secs, "nanos": nanos, "human": human}


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

    def end_record(
        self, name: str, tally: Tally, printed: int, elapsed: float
    ) -> bytes:
        """The --json record that closes one haystack's records.

        Args:
            name (str): its path as printed.
            tally (Tally): its tally.
            printed (int): the bytes printed for it.
            elapsed (float): the seconds its search took.
        """
        return json_line(
            {
                "type": "end",
                "data": {
                    "path": json_text(name),
                    "binary_offset": tally.nul,
                    "stats": {
                        "elapsed": duration(elapsed),
                        "searches": 1,
                        "searches_with_match": int(tally.selected),
                        "bytes_searched": tally.searched,
                        "bytes_printed": printed,
                        "matched_lines": tally.matched_lines,
                        "matches": tally.matches,
                    },
                },
            }
        )

    def summary_record(self, total: float) -> bytes:
        """The --json record that ends the output.

        Args:
            total (float): the seconds the whole search took.
        """
        return json_line(
            {
                "data": {
                    "elapsed_total": duration(total, True),
                    "stats": {
                        "bytes_printed": self.printed,
                        "bytes_searched": self.bytes_searched,
                        "elapsed": duration(self.elapsed, True),
                        "matched_lines": self.matched_lines,
                        "matches": self.matches,
                        "searches": self.searched,
                        "searches_with_match": self.with_match,
                    },
                },
                "type": "summary",
            }
        )

    def stats_block(self, total: float) -> bytes:
        """What --stats prints after the output.

        Args:
            total (float): the seconds the whole search took.
        """
        return (
            f"\n{self.matches} matches\n"
            f"{self.matched_lines} matched lines\n"
            f"{self.with_match} files contained matches\n"
            f"{self.searched} files searched\n"
            f"{self.printed} bytes printed\n"
            f"{self.bytes_searched} bytes searched\n"
            f"{self.elapsed:.6f} seconds spent searching\n"
            f"{total:.6f} seconds\n"
        ).encode()


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


RG_BUFFER_BYTES = 64 * 1024


class RgBinary:
    """ripgrep's binary detection over one haystack's bytes.

    grep-searcher looks for NUL in what it reads, ripgrep 14.1.1 in one
    of three modes. ``quit``, a walked file's: a NUL in the first 64 KiB
    leaves the whole file unsearched, and one past it ends the search
    there. ``convert``, a file named on the line or any file under
    ``--binary``: a NUL in the first 64 KiB (all a memory map checks)
    makes the file binary, its NULs read as line terminators, and a
    printed match gives way to one notice naming the first NUL's offset.
    ``text``, under -a or --null-data: nothing is looked at. ``note``, a
    named file under --json: the first NUL's offset is kept for the end
    record, and the file is searched as it is.

    Args:
        mode (str): ``quit``, ``convert``, ``note`` or ``text``.
    """

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.offset: int | None = None

    async def read(
        self, source: AsyncIterator[bytes], pipe: bool = False
    ) -> AsyncIterator[bytes]:
        """The haystack's bytes, read the way the mode reads them.

        ripgrep checks what one read returned, at most 64 KiB, before it
        searches a line of it.

        Args:
            source (AsyncIterator[bytes]): the haystack as served.
            pipe (bool): the haystack is stdin, whose read returns what
                has arrived; a file's read fills the buffer.
        """
        if self.mode == "text":
            async for chunk in source:
                yield chunk
            return
        position = 0
        async for block in self._reads(source, pipe):
            at = block.find(b"\0")
            if at >= 0 and self.mode == "quit":
                if position == 0:
                    self.offset = at
                return
            if at >= 0 and position == 0:
                self.offset = at
            position += len(block)
            yield self._converted(block)

    async def _reads(
        self, source: AsyncIterator[bytes], pipe: bool
    ) -> AsyncIterator[bytes]:
        """The reads ripgrep's buffer makes of the haystack.

        A pipe's read is whatever had arrived, so each served chunk is
        one, never waited past, and one longer than the buffer is cut
        into buffers. A file's first read fills the buffer, since the
        binary decision rests on it, so the chunks a backend serves (8
        KiB from disk and S3) are held until it is whole and joined
        once; later reads take what has arrived, so a search never waits
        past its answer. A walked file's first buffer grows until it
        holds a whole line, and a NUL in it ends the read the moment it
        arrives; a named file's first buffer is all a memory map checks.

        Args:
            source (AsyncIterator[bytes]): the haystack as served.
            pipe (bool): each served chunk is one read.
        """
        parts: list[bytes] = []
        size = 0
        newline: int | None = None
        nul: int | None = None
        filling = not pipe
        async for chunk in source:
            if not filling:
                for start in range(0, len(chunk), RG_BUFFER_BYTES):
                    yield chunk[start : start + RG_BUFFER_BYTES]
                continue
            if newline is None and (at := chunk.find(b"\n")) >= 0:
                newline = size + at
            if nul is None and (at := chunk.find(b"\0")) >= 0:
                nul = size + at
            parts.append(chunk)
            size += len(chunk)
            end = self._first_end(newline)
            if self.mode == "quit" and nul is not None:
                if end is None or nul < end:
                    yield b"".join(parts)
                    return
            if end is None or size < end:
                continue
            held = b"".join(parts)
            parts = []
            filling = False
            yield held[:end]
            for start in range(end, len(held), RG_BUFFER_BYTES):
                yield held[start : start + RG_BUFFER_BYTES]
        if parts:
            yield b"".join(parts)

    def _first_end(self, newline: int | None) -> int | None:
        """Where the first buffer ends: 64 KiB, or for a walked file the
        first 64 KiB step past its first newline, None until one came.

        Args:
            newline (int | None): the first newline's offset, if seen.
        """
        if self.mode != "quit":
            return RG_BUFFER_BYTES
        if newline is None:
            return None
        return (newline // RG_BUFFER_BYTES + 1) * RG_BUFFER_BYTES

    def notice(self, label: str | None) -> bytes:
        """ripgrep's line for a binary file a printed match was found in.

        Args:
            label (str | None): the path the output names, None for none.
        """
        head = "" if label is None else f"{label}: "
        return encode_text(
            f'{head}binary file matches (found "\\0" byte around '
            f"offset {self.offset})\n"
        )

    @property
    def skipped(self) -> bool:
        """Whether a walked file's first buffer held a NUL, so ripgrep
        searched none of it."""
        return self.mode == "quit" and self.offset is not None

    @property
    def converted(self) -> bool:
        """Whether the file is binary and reads its NULs as terminators,
        a printed match giving way to the notice."""
        return self.mode == "convert" and self.offset is not None

    def _converted(self, data: bytes) -> bytes:
        return data.replace(b"\0", b"\n") if self.converted else data


@dataclass(frozen=True, slots=True)
class Line:
    """One line of a haystack -U searched whole.

    Args:
        start (int): its byte offset.
        at (int): its index in the decoded haystack.
        text (str): the line, its terminator (and under --crlf its CR) off.
        cr (bool): --crlf took a CR off its end.
    """

    start: int
    at: int
    text: str
    cr: bool


@dataclass(slots=True)
class Region:
    """The lines -U selects for one match: every line it spans, a match
    whose lines overlap the region's joining it (grep-searcher's
    multi-line search).

    Args:
        first (int): the region's first line.
        last (int): its last line.
        matches (list[RegexMatch]): the matches it holds.
    """

    first: int
    last: int
    matches: list[RegexMatch] = field(default_factory=list)


def split_lines(text: str, f: RgFlags) -> list[Line]:
    """A haystack -U searched whole, cut at its line terminators.

    Args:
        text (str): the decoded haystack.
        f (RgFlags): the parsed flags.
    """
    pieces = text.split("\0" if f.null_data else "\n")
    if pieces[-1] == "":
        pieces.pop()
    lines: list[Line] = []
    at = start = 0
    for piece in pieces:
        cr = f.crlf and piece.endswith("\r")
        lines.append(Line(start, at, piece[:-1] if cr else piece, cr))
        at += len(piece) + 1
        start += _byte_len(piece) + 1
    return lines


def line_index(ats: list[int], at: int) -> int:
    """The last index whose value is at most ``at``.

    Args:
        ats (list[int]): ascending offsets.
        at (int): the offset to place.
    """
    return bisect_right(ats, at) - 1


def find_regions(pat: Pattern, text: str, lines: list[Line]) -> list[Region]:
    """The regions -U selects, in order.

    Args:
        pat (Pattern): the compiled pattern.
        text (str): the decoded haystack.
        lines (list[Line]): its lines.
    """
    ats = [line.at for line in lines]
    regions: list[Region] = []
    for m in rust_matches(pat, text):
        start = match_start(m)
        if not lines or start >= len(text) and text.endswith(("\n", "\0")):
            break
        first = line_index(ats, start)
        last = line_index(ats, max(start, m.end() - 1))
        if regions and regions[-1].last >= first:
            regions[-1].last = max(regions[-1].last, last)
            regions[-1].matches.append(m)
        else:
            regions.append(Region(first, last, [m]))
    return regions


def json_text(text: str) -> JsonValue:
    """ripgrep's JSON for some text: ``text`` when it is UTF-8, else its
    bytes in base64.

    Args:
        text (str): the text, from ``decode_text``.
    """
    raw = encode_text(text)
    try:
        return {"text": raw.decode("utf-8")}
    except UnicodeDecodeError:
        return {"bytes": base64.b64encode(raw).decode("ascii")}


def json_line(message: JsonValue) -> bytes:
    """One JSON Lines record as ripgrep writes it.

    Args:
        message (JsonValue): the record.
    """
    return compact_json_bytes(message) + b"\n"


def tally_line(tally: Tally, pat: Pattern, text: str, f: RgFlags) -> None:
    """Count one selected line for --stats and --json.

    Args:
        tally (Tally): the haystack's tally.
        pat (Pattern): the compiled pattern.
        text (str): the line.
        f (RgFlags): the parsed flags.
    """
    tally.matched_lines += 1
    if not f.invert:
        tally.matches += sum(1 for _ in rust_matches(pat, text))


class RgPrinter:
    """How one haystack's selected and context lines print (ripgrep's
    standard printer): the fields, -o/--vimgrep/-r, --trim and -M; under
    --json, one match or context record per line.

    Args:
        f (RgFlags): the parsed flags.
        pat (Pattern): the compiled pattern.
        label (str | None): the path every record leads with, None when
            the records carry none (a single unlabelled input, or a
            --heading that already named the file).
        name (str): the path a --json record names.
    """

    def __init__(
        self,
        f: RgFlags,
        pat: Pattern,
        label: str | None,
        name: str = "",
    ) -> None:
        self._f = f
        self._pat = pat
        self._label = label
        self._name = name
        # The line the haystack ends on without a terminator, which a
        # --json record shows as it is.
        self.open_line: int | None = None
        # ripgrep tracks each match of a line only when something needs
        # it, and -M words its refusal from whether it did.
        self._granular = (
            f.column or f.vimgrep or f.replace is not None or f.only_matching
        )

    def context(
        self, index: int, start: int, text: str, cr: bool = False
    ) -> list[bytes]:
        """The records one context line prints: the line, or under -o each
        of its matches (the whole line when it has none).

        Args:
            index (int): the line's 0-based index.
            start (int): the line's byte offset.
            text (str): the line, from ``decode_text``.
            cr (bool): --crlf took a CR off the line's end.
        """
        if self._f.json:
            return [self.json_record("context", index, start, text, cr, [])]
        if self._f.only_matching:
            return list(
                self._pieces(
                    index,
                    start,
                    text,
                    list(rust_matches(self._pat, text)),
                    False,
                    cr,
                )
            )
        return [self._record(index, None, start, text, [], False, True, 0, cr)]

    def selected(
        self, index: int, start: int, text: str, cr: bool = False
    ) -> Iterator[bytes]:
        """The records one selected line prints, one per match under -o
        and --vimgrep, produced as they are asked for.

        Args:
            index (int): the line's 0-based index.
            start (int): the line's byte offset.
            text (str): the line, from ``decode_text``.
            cr (bool): --crlf took a CR off the line's end.
        """
        f = self._f
        if f.json:
            found = [] if f.invert else list(rust_matches(self._pat, text))
            hits = [(match_start(m), m.end(), match_text(m)) for m in found]
            yield self.json_record("match", index, start, text, cr, hits)
            return
        matches = (
            []
            if f.invert or not self._granular
            else list(rust_matches(self._pat, text))
        )
        if f.only_matching:
            yield from self._pieces(index, start, text, matches, True, cr)
            return
        if f.replace is not None and matches:
            shown, spans = replace_all(self._pat, text, f.replace)
            terminated = False
        else:
            shown = text
            spans = [(match_start(m), m.end()) for m in matches]
            terminated = True
        if f.vimgrep and matches:
            # One record per match, each at its own column unless
            # --no-column took the columns away.
            cursor = ByteCursor(shown)
            for s, _ in spans:
                column = 1 + cursor.at(s) if f.column else None
                yield self._record(
                    index,
                    column,
                    start,
                    shown,
                    spans,
                    True,
                    terminated,
                    len(matches),
                    cr,
                )
            return
        column = None
        if f.column and spans:
            column = 1 + byte_offset(shown, spans[0][0])
        yield self._record(
            index,
            column,
            start,
            shown,
            spans,
            True,
            terminated,
            len(matches),
            cr,
        )

    def json_record(
        self,
        kind: str,
        index: int,
        start: int,
        text: str,
        cr: bool,
        spans: list[tuple[int, int, str]],
        last: int | None = None,
    ) -> bytes:
        """One --json match or context record: the lines as they were
        read, the first one's number and offset, each match's byte span.

        Args:
            kind (str): ``match`` or ``context``.
            index (int): the first line's 0-based index.
            start (int): its byte offset.
            text (str): the lines, terminators between them kept and the
                last one's (and a --crlf CR) off.
            cr (bool): --crlf took a CR off the last line.
            spans (list[tuple[int, int, str]]): each match's start and
                end in ``text``, and the text it matched.
            last (int | None): the last line's index, for -U's regions.
        """
        f = self._f
        end = (
            ""
            if (index if last is None else last) == self.open_line
            else "\0"
            if f.null_data
            else "\n"
        )
        # A -U match may take the last line's terminator in.
        whole = text + ("\r" if cr else "") + end
        submatches: list[JsonValue] = [
            {
                "match": json_text(matched),
                "start": _byte_len(whole[:begin]),
                "end": _byte_len(whole[:finish]),
            }
            for begin, finish, matched in spans
        ]
        return json_line(
            {
                "type": kind,
                "data": {
                    "path": json_text(self._name),
                    "lines": json_text(whole),
                    "line_number": index + 1 if f.line_numbers else None,
                    "absolute_offset": start,
                    "submatches": submatches,
                },
            }
        )

    def region(
        self, region: Region, lines: list[Line], text: str, ats: list[int]
    ) -> dict[int, list[bytes]]:
        """The records one -U region prints, by line: every line it spans,
        at the column its first match starts; under -o each match's part
        of each line; under -r the region once, replaced, on its first
        line; under --vimgrep each match on the line it starts.

        Args:
            region (Region): the region.
            lines (list[Line]): the haystack's lines.
            text (str): the decoded haystack.
            ats (list[int]): each line's index in ``text``.
        """
        f = self._f
        records: dict[int, list[bytes]] = {}

        def offset_of(index: int, at: int) -> int:
            line = lines[index]
            return line.start + _byte_len(text[line.at : at])

        def add(index: int, record: bytes) -> None:
            records.setdefault(index, []).append(record)

        def replaced(index: int, column: int | None, shown: str) -> None:
            # A replacement holding a record terminator prints as one
            # record each, numbered on from the line it starts.
            for k, piece in enumerate(
                shown.split("\0" if f.null_data else "\n")
            ):
                at = min(index + k, len(lines) - 1)
                add(
                    index,
                    self._record(
                        index + k,
                        column,
                        lines[at].start,
                        piece,
                        [],
                        True,
                        False,
                        1,
                        lines[at].cr,
                    ),
                )

        first = lines[region.first]
        head = match_start(region.matches[0])
        column = 1 + offset_of(region.first, head) - first.start
        if f.json:
            last = lines[region.last]
            spanned = text[first.at : last.at + len(last.text)]
            moved = [
                (match_start(m) - first.at, m.end() - first.at, match_text(m))
                for m in region.matches
            ]
            add(
                region.first,
                self.json_record(
                    "match",
                    region.first,
                    first.start,
                    spanned,
                    last.cr,
                    moved,
                    region.last,
                ),
            )
            return records
        if f.vimgrep and f.replace is None:
            for m in region.matches:
                start = match_start(m)
                i = line_index(ats, start)
                line = lines[i]
                at = offset_of(i, start)
                add(
                    i,
                    self._record(
                        i,
                        1 + at - line.start if f.column else None,
                        line.start,
                        line.text,
                        [],
                        True,
                        True,
                        1,
                        line.cr,
                    ),
                )
            return records
        if f.only_matching or f.vimgrep:
            # Every line of a match prints at the match's own offset and
            # column.
            for m in region.matches:
                start = match_start(m)
                i = line_index(ats, start)
                at = offset_of(i, start)
                shown_column = 1 + at - lines[i].start if f.column else None
                if f.replace is not None:
                    replaced(i, shown_column, expand(f.replace, m))
                    continue
                for j in range(
                    i, line_index(ats, max(start, m.end() - 1)) + 1
                ):
                    line = lines[j]
                    a = max(start, line.at)
                    piece = text[a : min(m.end(), line.at + len(line.text))]
                    add(
                        j,
                        self._record(
                            j,
                            shown_column,
                            at,
                            piece,
                            [(0, len(piece))],
                            True,
                            False,
                            1,
                            line.cr,
                        ),
                    )
            return records
        if f.replace is not None:
            last = lines[region.last]
            shown: list[str] = []
            position = first.at
            for m in region.matches:
                shown.append(text[position : match_start(m)])
                shown.append(expand(f.replace, m))
                position = max(position, m.end())
            shown.append(text[position : last.at + len(last.text)])
            replaced(
                region.first, column if f.column else None, "".join(shown)
            )
            return records
        for i in range(region.first, region.last + 1):
            line = lines[i]
            add(
                i,
                self._record(
                    i,
                    column if f.column else None,
                    line.start,
                    line.text,
                    [],
                    True,
                    True,
                    0,
                    line.cr,
                ),
            )
        return records

    def _pieces(
        self,
        index: int,
        start: int,
        text: str,
        matches: list[RegexMatch],
        is_match: bool,
        cr: bool,
    ) -> Iterator[bytes]:
        """-o's records for one line: every match, an empty one included,
        each at its own offset, or the whole line when nothing in it
        matches, which is how ripgrep 14.1.1 prints an inverted selection
        and a context line under -o.

        Args:
            index (int): the line's 0-based index.
            start (int): the line's byte offset.
            text (str): the line.
            matches (list[RegexMatch]): the line's matches.
            is_match (bool): a selected line, not a context line.
            cr (bool): --crlf took a CR off the line's end.
        """
        f = self._f
        if not matches:
            yield self._record(
                index, None, start, text, [], is_match, True, 0, cr
            )
            return
        cursor = ByteCursor(text)
        for m in matches:
            piece = match_text(m)
            if f.replace is not None and is_match:
                piece = expand(f.replace, m)
            offset = cursor.at(match_start(m))
            column = 1 + offset if f.column and is_match else None
            yield self._record(
                index,
                column,
                start + offset,
                piece,
                [(0, len(piece))],
                is_match,
                False,
                1,
            )

    def _record(
        self,
        index: int,
        column: int | None,
        offset: int,
        text: str,
        spans: list[tuple[int, int]],
        is_match: bool,
        terminated: bool,
        count: int,
        cr: bool = False,
    ) -> bytes:
        """One printed record.

        Args:
            index (int): the line's 0-based index.
            column (int | None): the 1-based byte column to print.
            offset (int): the byte offset -b prints.
            text (str): the text to print.
            spans (list[tuple[int, int]]): the matches in ``text``.
            is_match (bool): a selected line, not a context line.
            terminated (bool): whether ripgrep's -M counts the line's
                terminator in its length (a plain line does, a replaced
                line and a -o match do not).
            count (int): the line's match count -M reports.
            cr (bool): --crlf took a CR off the line's end. A line
                printed as it was read ends as it did; every other
                record ends as ``record_end`` says.
        """
        f = self._f
        sep = (
            f.field_match_separator if is_match else f.field_context_separator
        )
        head = ""
        if self._label is not None:
            head = self._label + ("\0" if f.null else sep)
        if f.line_numbers:
            head += f"{index + 1}{sep}"
        if column is not None:
            head += f"{column}{sep}"
        if f.byte_offsets:
            head += f"{offset}{sep}"
        body = text
        if f.trim:
            body = text.lstrip(ASCII_SPACE)
            cut = len(text) - len(body)
            spans = [(s - cut, e - cut) for s, e in spans if s >= cut]
        if f.max_columns and (
            _byte_len(body) + int(terminated) > f.max_columns
        ):
            body = self._exceeded(body, spans, is_match, count)
            terminated = False
        end = b"\n" if f.crlf and terminated and not cr else record_end(f)
        return encode_text(f"{head}{body}") + end

    def _exceeded(
        self,
        body: str,
        spans: list[tuple[int, int]],
        is_match: bool,
        count: int,
    ) -> str:
        """What -M prints for a line longer than its limit.

        Args:
            body (str): the text that was too long.
            spans (list[tuple[int, int]]): the matches in ``body``.
            is_match (bool): a selected line, not a context line.
            count (int): the line's match count.
        """
        f = self._f
        limit = f.max_columns or 0
        granular = self._granular and is_match and bool(spans)
        if f.max_columns_preview:
            shown = body[:limit]
            if not granular:
                return shown + OMITTED_END
            remaining = sum(1 for s, _ in spans if len(shown) <= s < len(body))
            noun = "match" if remaining == 1 else "matches"
            return f"{shown} [... {remaining} more {noun}]"
        if not granular or f.only_matching:
            return OMITTED_MATCHING if is_match else OMITTED_CONTEXT
        return f"[Omitted long line with {count} matches]"


async def _selects(pat: Pattern, text: str, invert: bool) -> bool:
    await prepare(pat, text)
    return bool(pat.search(text)) != invert


@dataclass(slots=True)
class NonmatchStop:
    """Where --stop-on-nonmatch ends a file: at the first unselected line
    after a selected one.

    ripgrep's fast inverted search is one line late: the pattern line
    that ends the first run of selected lines is passed over, unprinted,
    and the stop comes at the next unselected line. That is how it reads
    a file it names (through a memory map); a buffered read of stdin
    stops at that first pattern line instead, which is not reproduced.
    --passthru reads line by line and is never late.

    Args:
        enabled (bool): --stop-on-nonmatch.
        late (bool): -v without --passthru.
    """

    enabled: bool
    late: bool
    armed: bool = False
    seen: bool = False

    def select(self) -> None:
        """Record a selected line."""
        self.seen = True
        if self.enabled and not self.late:
            self.armed = True

    def passes_over(self) -> bool:
        """Whether this unselected line is the one a late stop passes
        over, which arms it."""
        if self.enabled and self.late and self.seen and not self.armed:
            self.armed = True
            return True
        return False


def nonmatch_stop(f: RgFlags) -> NonmatchStop:
    """The --stop-on-nonmatch state for one haystack.

    Args:
        f (RgFlags): the parsed flags.
    """
    return NonmatchStop(f.stop_on_nonmatch, f.invert and not f.passthru)


async def _records(
    lines: AsyncLineIterator, f: RgFlags, pat: Pattern
) -> AsyncIterator[tuple[bytes, int, int, bool]]:
    """Read records through the delimiter selected by rg, each with the
    records and bytes skipped before it.

    A record holding none of the pattern's needles cannot be selected, so
    it is skipped unless the output prints or stops at unselected records:
    -v, --stop-on-nonmatch, --passthru and printed context.

    Args:
        lines (AsyncLineIterator): The input cursor.
        f (RgFlags): The parsed flags.
        pat (Pattern): The compiled line matcher.
    """
    needles = (
        None
        if f.invert or f.stop_on_nonmatch or f.passthru or prints_context(f)
        else required_needles(
            pat.original if isinstance(pat, AsyncRegex) else pat
        )
    )
    fold = bool(pat.flags & re.IGNORECASE)
    delimiter = b"\0" if f.null_data else b"\n"
    while True:
        skipped, size = (
            lines.skip_nonmatching_lines(needles, fold, delimiter)
            if needles is not None
            else (0, 0)
        )
        raw, terminated = await lines.read_until(delimiter)
        if not terminated and not raw:
            return
        if isinstance(pat, AsyncRegex):
            await pat.prepare(
                read_line(raw, f)[0],
                lambda: (
                    (
                        read_line(item, f)[0]
                        for item in lines.buffered_lines(
                            delimiter, needles=needles, ignore_case=fold
                        )
                    )
                    if f.max_count is None
                    and not (
                        f.quiet
                        or f.files_only
                        or f.files_without_match
                        or f.stop_on_nonmatch
                    )
                    else ()
                ),
            )
        yield raw, skipped, size, terminated


async def _listing(
    lines: AsyncLineIterator, pat: Pattern, f: RgFlags, tally: Tally
) -> None:
    """Read no further than the first selected line (-q, -l and
    --files-without-match need only that one bit), unless --stats or
    --json count every one, up to -m.

    Args:
        lines (AsyncLineIterator): the haystack's lines.
        pat (Pattern): the compiled pattern.
        f (RgFlags): the parsed flags.
        tally (Tally): receives the selection.
    """
    selected = 0
    async for raw, _, _, _ in _records(lines, f, pat):
        text, _ = read_line(raw, f)
        if await _selects(pat, text, f.invert):
            tally.selected = True
            if not (f.stats or f.json):
                return
            tally_line(tally, pat, text, f)
            selected += 1
            if f.max_count is not None and selected >= f.max_count:
                return


async def _count(
    lines: AsyncLineIterator, pat: Pattern, f: RgFlags, tally: Tally
) -> int:
    """-c's selected lines, or --count-matches' matches, up to -m.

    Args:
        lines (AsyncLineIterator): the haystack's lines.
        pat (Pattern): the compiled pattern.
        f (RgFlags): the parsed flags.
        tally (Tally): receives the selection.
    """
    count = 0
    selected = 0
    stop = nonmatch_stop(f)
    async for raw, _, _, _ in _records(lines, f, pat):
        text, _ = read_line(raw, f)
        if not await _selects(pat, text, f.invert):
            if stop.armed:
                break
            stop.passes_over()
            continue
        stop.select()
        selected += 1
        tally.selected = True
        # Matches are found only when something counts them; an inverted
        # selection has none.
        found = (
            sum(1 for _ in rust_matches(pat, text))
            if not f.invert
            and (f.stats or f.json or f.count_matches or f.only_matching)
            else 0
        )
        if f.stats or f.json:
            tally.matched_lines += 1
            tally.matches += found
        if (
            f.only_matching
            and f.count_only
            or f.count_matches
            and not f.invert
        ):
            # -o -c counts matches, which an inverted selection has none
            # of, and still lists the input (ripgrep 14.1.1).
            count += found
        else:
            count += 1
        if f.max_count is not None and selected >= f.max_count:
            break
    return count


async def _printed_lines(
    lines: AsyncLineIterator,
    printer: RgPrinter,
    pat: Pattern,
    f: RgFlags,
    tally: Tally,
    binary: RgBinary,
    label: str | None,
) -> AsyncIterator[bytes]:
    """The printed lines of one haystack, context and all.

    Selected lines and their context, grouped the way ripgrep groups
    them, with the context separator between groups. It holds only the
    last -B lines nothing has printed yet, and stops reading once -m has
    selected its last line and that line's trailing context is out; a
    trailing line that would be selected prints as selected, still
    counted as context. --passthru prints every line up to the -m-th
    selected one and separates nothing. --stop-on-nonmatch ends the file
    where ``NonmatchStop`` says.

    Args:
        lines (AsyncLineIterator): the haystack's lines.
        printer (RgPrinter): how records print.
        pat (Pattern): the compiled pattern.
        f (RgFlags): the parsed flags.
        tally (Tally): receives the selection.
        binary (RgBinary): the haystack's binary detection; a binary
            file prints its notice at the first selected line and
            nothing else.
        label (str | None): the path the notice leads with.
    """
    context = prints_context(f)
    held: deque[tuple[int, int, str, bool]] = deque(
        maxlen=f.context_before if context else 0
    )
    budget = YieldBudget()
    index = -1
    position = 0
    selected = 0
    last_printed = -1
    after_left = 0
    stop = nonmatch_stop(f)
    counts = f.stats or f.json
    async for raw, skipped, size, terminated in _records(lines, f, pat):
        index += skipped
        position += size
        index += 1
        start = position
        position += len(raw) + 1
        text, cr = read_line(raw, f)
        if not terminated:
            printer.open_line = index
        hit = await _selects(pat, text, f.invert)
        if binary.converted:
            if hit:
                tally.selected = True
                tally.binary = True
                if counts:
                    tally_line(tally, pat, text, f)
                yield binary.notice(label)
                return
            continue
        if not hit and stop.armed:
            # The line that stops the file still prints as the context
            # it is.
            if f.passthru or after_left > 0:
                for chunk in printer.context(index, start, text, cr):
                    yield chunk
            return
        if not hit and stop.passes_over():
            if context:
                held.append((index, start, text, cr))
            continue
        selecting = f.max_count is None or selected < f.max_count
        records: Iterable[bytes] = ()
        if hit and selecting:
            stop.select()
            selected += 1
            tally.selected = True
            if counts:
                tally_line(tally, pat, text, f)
            if context:
                first = held[0][0] if held else index
                if (
                    last_printed >= 0
                    and first > last_printed + 1
                    and f.context_separator is not None
                ):
                    yield encode_text(f.context_separator) + record_end(f)
                for i, s, t, c in held:
                    await prepare(pat, t)
                    for chunk in printer.context(i, s, t, c):
                        yield chunk
                held.clear()
                after_left = f.context_after
            await prepare(pat, text)
            records = printer.selected(index, start, text, cr)
            last_printed = index
        elif f.passthru:
            if not selecting:
                return
            records = printer.context(index, start, text, cr)
            last_printed = index
        elif after_left > 0:
            records = (
                printer.selected(index, start, text, cr)
                if hit
                else printer.context(index, start, text, cr)
            )
            after_left -= 1
            last_printed = index
        elif context:
            held.append((index, start, text, cr))
        for chunk in records:
            yield chunk
            await budget.run()
        await budget.run()
        if (
            f.max_count is not None
            and selected >= f.max_count
            and after_left == 0
        ):
            return


def _listed(name: str, f: RgFlags, tally: Tally) -> Iterator[bytes]:
    """The name -l or --files-without-match prints for a haystack, if any.

    Args:
        name (str): the haystack's path as printed.
        f (RgFlags): the parsed flags.
        tally (Tally): what the search selected.
    """
    if not f.quiet and tally.selected == f.files_only:
        yield encode_text(name) + (b"\0" if f.null else record_end(f))


def _counted(
    count: int, label: str | None, f: RgFlags, tally: Tally
) -> Iterator[bytes]:
    """The count -c or --count-matches prints for a haystack, if any.

    Args:
        count (int): the count.
        label (str | None): the path it leads with, None for none.
        f (RgFlags): the parsed flags.
        tally (Tally): what the search selected.
    """
    if tally.selected or f.include_zero:
        head = b""
        if label is not None:
            head = encode_text(label) + (b"\0" if f.null else b":")
        yield head + str(count).encode() + record_end(f)


async def _multiline(
    reader: AsyncIterator[bytes],
    pat: Pattern,
    f: RgFlags,
    name: str,
    label: str | None,
    tally: Tally,
    binary: RgBinary,
) -> AsyncIterator[bytes]:
    """One haystack as -U searches it: read whole and matched across its
    lines, each region a unit for -c and -m (ripgrep 14.1.1).

    -v selects the lines no region spans; ripgrep counts nothing then.
    Context and --passthru print around the selected lines as they do
    line by line, and a line after -m's last unit that would be selected
    prints as selected, still counted as context.

    Args:
        reader (AsyncIterator[bytes]): the haystack, binary-checked.
        pat (Pattern): the compiled pattern.
        f (RgFlags): the parsed flags.
        name (str): the haystack's path as -l prints it.
        label (str | None): the path each record leads with.
        tally (Tally): receives the selection.
        binary (RgBinary): the haystack's binary detection.
    """
    data = b"".join([chunk async for chunk in reader])
    tally.searched = len(data)
    if binary.skipped:
        tally.skipped = True
        return
    text = decode_text(data)
    lines = split_lines(text, f)
    await prepare(pat, text)
    regions = find_regions(pat, text, lines)
    spanned = {i for r in regions for i in range(r.first, r.last + 1)}
    units = (
        [Region(i, i) for i in range(len(lines)) if i not in spanned]
        if f.invert
        else regions
    )
    # --stop-on-nonmatch ends the file at the first line no region holds
    # once one was selected; ripgrep 14.1.1 lets -v run on.
    stop: int | None = None
    if f.stop_on_nonmatch and not f.invert:
        for k in range(1, len(units)):
            if units[k].first > units[k - 1].last + 1:
                stop = units[k - 1].last + 1
                units = units[:k]
                break
    kept = units if f.max_count is None else units[: f.max_count]
    tally.selected = bool(kept)
    tally.matched_lines = sum(r.last - r.first + 1 for r in kept)
    tally.matches = sum(len(r.matches) for r in kept)
    if f.quiet or f.files_only or f.files_without_match:
        for chunk in _listed(name, f, tally):
            yield chunk
        return
    if f.count_only or f.count_matches:
        if f.invert:
            tally.selected = False
            return
        matches = f.count_matches or f.only_matching
        count = sum(len(r.matches) if matches else 1 for r in kept)
        for chunk in _counted(count, label, f, tally):
            yield chunk
        return
    if not kept and (not f.passthru or binary.converted):
        return
    if binary.converted:
        tally.binary = True
        yield binary.notice(label)
        return
    printer = RgPrinter(f, pat, None if f.heading else label, name)
    if text and not text.endswith("\0" if f.null_data else "\n"):
        printer.open_line = len(lines) - 1

    def records(chosen: list[Region]) -> dict[int, list[bytes]]:
        out: dict[int, list[bytes]] = {}
        for r in chosen:
            for i in range(r.first, r.last + 1):
                out.setdefault(i, [])
            if f.invert:
                line = lines[r.first]
                out[r.first] = list(
                    printer.selected(r.first, line.start, line.text, line.cr)
                )
            else:
                for i, chunk in printer.region(r, lines, text, ats).items():
                    out[i].extend(chunk)
        return out

    ats = [line.at for line in lines]
    picked = records(kept)
    extra = records(units[len(kept) :]) if f.context_after else {}
    end = kept[-1].last if f.max_count is not None and kept else None
    context = prints_context(f)
    held: deque[int] = deque(maxlen=f.context_before if context else 0)
    budget = YieldBudget()
    last_printed = -1
    after_left = 0
    for i, line in enumerate(lines):
        if end is not None and i > end and (after_left == 0 or f.passthru):
            return
        if stop is not None and i > stop:
            return
        chunks: Iterable[bytes] = ()
        if i in picked:
            if context:
                first = held[0] if held else i
                if (
                    last_printed >= 0
                    and first > last_printed + 1
                    and f.context_separator is not None
                ):
                    yield encode_text(f.context_separator) + record_end(f)
                for h in held:
                    await prepare(pat, lines[h].text)
                    for chunk in printer.context(
                        h, lines[h].start, lines[h].text, lines[h].cr
                    ):
                        yield chunk
                held.clear()
                after_left = f.context_after
            chunks = picked[i]
            last_printed = i
        elif f.passthru or after_left > 0:
            await prepare(pat, line.text)
            # A line after -m's last unit that a later unit would select
            # prints as selected and then again as context (ripgrep 14.1.1).
            chunks = [
                *extra.get(i, []),
                *printer.context(i, line.start, line.text, line.cr),
            ]
            after_left = max(after_left - 1, 0)
            last_printed = i
        elif context:
            held.append(i)
        for chunk in chunks:
            yield chunk
        await budget.run()


async def _framed(
    head: bytes, source: AsyncIterator[bytes]
) -> AsyncIterator[tuple[bytes, bool]]:
    yield head, False
    async for chunk in source:
        yield chunk, False
    yield b"", True


async def transcoded(
    source: AsyncIterator[bytes], encoding: str
) -> AsyncIterator[bytes]:
    """A haystack's bytes as ripgrep searches them under -E auto or a
    named encoding.

    A leading byte-order mark is dropped, and a UTF-16 one picks UTF-16
    whatever -E said, where a UTF-8 one leaves the choice alone. Under
    auto with no UTF-16 mark the rest passes as it is, invalid UTF-8
    included. Otherwise it is decoded to UTF-8, a sequence the encoding
    does not map becoming U+FFFD, and a UTF encoding drops a second mark
    of its own too (encoding_rs_io, ripgrep 14.1.1).

    Args:
        source (AsyncIterator[bytes]): the haystack's bytes.
        encoding (str): auto, or the WHATWG name -E gave.
    """
    head = b""
    try:
        async for chunk in source:
            head += chunk
            if len(head) >= 3:
                break
        named = None if encoding == "auto" else encoding
        bom = bom_of(head)
        if bom is not None:
            head = head[len(bom[0]) :]
            named = named if bom[1] == "UTF-8" else bom[1]
        if named is None:
            if head:
                yield head
            async for chunk in source:
                yield chunk
            return
        decode = decoder_for(named)
        marked = any(named == name for _, name in BOMS)
        async for chunk, last in _framed(head, source):
            text = decode(chunk, last)
            if marked and text:
                text, marked = text.removeprefix("\ufeff"), False
            if text:
                yield encode_text(text)
    finally:
        await close_quietly(source)


async def search_haystack(
    source: AsyncIterator[bytes],
    pat: re.Pattern[str],
    f: RgFlags,
    name: str,
    label: str | None,
    tally: Tally,
    named: bool = True,
    pipe: bool = False,
    worker: Worker | None = None,
) -> AsyncIterator[bytes]:
    """One haystack's output as ripgrep prints it, read no further than
    the answer needs: -q, -l and --files-without-match stop at the first
    selected line, and -m at its last one and that line's trailing
    context, so a pipe that goes on past the answer is never waited on.
    Whatever stops the search closes the haystack's reader.

    Args:
        source (AsyncIterator[bytes]): the haystack's bytes.
        pat (re.Pattern[str]): the compiled pattern.
        f (RgFlags): the parsed flags.
        name (str): the haystack's path as printed, which -l and
            --files-without-match answer with.
        label (str | None): the path each record leads with, None when
            the output names no file.
        tally (Tally): receives whether a line was selected.
        named (bool): the haystack was named on the line (or is stdin),
            which ripgrep searches past a NUL where a walked file is
            skipped.
        pipe (bool): the haystack is stdin, read as it arrives.
        worker (Worker | None): shared worker for a multi-file invocation.
    """
    if f.max_count == 0:
        # ripgrep selects no line at all under -m0 and prints nothing,
        # count and listing included.
        await close_quietly(source)
        return
    binary = RgBinary(
        "text"
        if f.text or f.null_data
        else "note"
        if f.json and (named or f.binary)
        else "convert"
        if named or f.binary
        else "quit"
    )
    matcher = AsyncRegex(
        pat,
        all_matches=not (
            (f.quiet or f.files_only or f.files_without_match)
            and not (f.stats or f.json or (f.multiline and f.invert))
        ),
        restart=True,
        worker=worker,
    )
    reader = binary.read(
        source if f.encoding == "none" else transcoded(source, f.encoding),
        pipe,
    )
    lines = AsyncLineIterator(reader)
    try:
        if f.multiline:
            async for chunk in _multiline(
                reader, matcher, f, name, label, tally, binary
            ):
                yield chunk
            return
        if f.quiet or f.files_only or f.files_without_match:
            await _listing(lines, matcher, f, tally)
            if binary.skipped:
                # A walked binary file was never searched, so it is in
                # neither listing.
                tally.skipped = True
                return
            for chunk in _listed(name, f, tally):
                yield chunk
            return
        if f.count_only or f.count_matches:
            count = await _count(lines, matcher, f, tally)
            if binary.skipped:
                return
            for chunk in _counted(count, label, f, tally):
                yield chunk
            return
        printer = RgPrinter(f, matcher, None if f.heading else label, name)
        async for chunk in _printed_lines(
            lines, printer, matcher, f, tally, binary, label
        ):
            yield chunk
    except BaseException as exc:
        if not isinstance(exc, GeneratorExit):
            await discard_streams(source)
        raise
    finally:
        await matcher.close()
        tally.nul = binary.offset
        if not f.multiline:
            # ripgrep counts the bytes it read up to where it stopped, and
            # a binary file up to its first NUL.
            tally.searched = (
                binary.offset if binary.offset is not None else lines.position
            )
        await close_quietly(reader)
        await close_quietly(source)
