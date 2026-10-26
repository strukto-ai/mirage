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
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

from mirage.io.stream import close_quietly
from mirage.shell.bytes import encode_text
from mirage.utils.encoding import BOMS, bom_of, decoder_for

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
