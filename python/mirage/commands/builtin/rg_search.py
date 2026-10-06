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
from collections import deque
from collections.abc import AsyncIterator, Iterable, Iterator
from dataclasses import dataclass

from mirage.commands.builtin.grep_prefilter import required_needles
from mirage.commands.builtin.utils.pcre import (
    match_start,
    match_text,
    user_groups,
)
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import close_quietly, discard_streams
from mirage.io.yield_budget import YieldBudget
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.helpers import byte_offset

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
    which also searches the files a walk would skip as binary.
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
    engine: str = "default"
    threads: int | None = None
    text: bool = False
    unicode: bool = True


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


def rust_matches(pat: re.Pattern[str], text: str) -> Iterator[re.Match[str]]:
    """Every match on a line in the order Rust's regex iterates them.

    After an empty match the search resumes one character on, and an
    empty match where the previous match ended is skipped: ``b*`` over
    ``abc`` is empty, ``b``, empty, where ``finditer`` also yields the
    empty match right after ``b``.

    Args:
        pat (re.Pattern[str]): the compiled pattern.
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


def _capture(m: re.Match[str], ref: str) -> str:
    """One group's text for a replacement, empty when there is none.

    Args:
        m (re.Match[str]): the match.
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


def expand(template: str, m: re.Match[str]) -> str:
    """One match's -r replacement, expanded as Rust's ``Captures::expand``.

    ``$1``, ``${1}``, ``$name`` and ``${name}`` name a group, a name
    being the longest run of ``[0-9A-Za-z_]`` (so ``$1x`` is the group
    ``1x``), a group that did not take part is empty, ``$$`` is ``$``,
    and a ``$`` no name follows is itself.

    Args:
        template (str): the replacement as typed.
        m (re.Match[str]): the match to expand it for.
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
    pat: re.Pattern[str], text: str, template: str
) -> tuple[str, list[tuple[int, int]]]:
    """The line with every match replaced, and where each replacement
    landed in it (character spans), which --vimgrep's columns and -M's
    preview count read.

    Args:
        pat (re.Pattern[str]): the compiled pattern.
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
    """

    selected: bool = False
    binary: bool = False
    skipped: bool = False


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
    ``text``, under -a or --null-data: nothing is looked at.

    Args:
        mode (str): ``quit``, ``convert`` or ``text``.
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

    def _converted(self, data: bytes) -> bytes:
        return data.replace(b"\0", b"\n") if self.offset is not None else data


class RgPrinter:
    """How one haystack's selected and context lines print (ripgrep's
    standard printer): the fields, -o/--vimgrep/-r, --trim and -M.

    Args:
        f (RgFlags): the parsed flags.
        pat (re.Pattern[str]): the compiled pattern.
        label (str | None): the path every record leads with, None when
            the records carry none (a single unlabelled input, or a
            --heading that already named the file).
    """

    def __init__(
        self, f: RgFlags, pat: re.Pattern[str], label: str | None
    ) -> None:
        self._f = f
        self._pat = pat
        self._label = label
        # ripgrep tracks each match of a line only when something needs
        # it, and -M words its refusal from whether it did.
        self._granular = (
            f.column or f.vimgrep or f.replace is not None or f.only_matching
        )

    def context(self, index: int, start: int, text: str) -> list[bytes]:
        """The records one context line prints: the line, or under -o each
        of its matches (the whole line when it has none).

        Args:
            index (int): the line's 0-based index.
            start (int): the line's byte offset.
            text (str): the line, from ``decode_text``.
        """
        if self._f.only_matching:
            return list(
                self._pieces(
                    index,
                    start,
                    text,
                    list(rust_matches(self._pat, text)),
                    False,
                )
            )
        return [self._record(index, None, start, text, [], False, True, 0)]

    def selected(self, index: int, start: int, text: str) -> Iterator[bytes]:
        """The records one selected line prints, one per match under -o
        and --vimgrep, produced as they are asked for.

        Args:
            index (int): the line's 0-based index.
            start (int): the line's byte offset.
            text (str): the line, from ``decode_text``.
        """
        f = self._f
        matches = (
            []
            if f.invert or not self._granular
            else list(rust_matches(self._pat, text))
        )
        if f.only_matching:
            yield from self._pieces(index, start, text, matches, True)
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
                )
            return
        column = None
        if f.column and spans:
            column = 1 + byte_offset(shown, spans[0][0])
        yield self._record(
            index, column, start, shown, spans, True, terminated, len(matches)
        )

    def _pieces(
        self,
        index: int,
        start: int,
        text: str,
        matches: list[re.Match[str]],
        is_match: bool,
    ) -> Iterator[bytes]:
        """-o's records for one line: every match, an empty one included,
        each at its own offset, or the whole line when nothing in it
        matches, which is how ripgrep 14.1.1 prints an inverted selection
        and a context line under -o.

        Args:
            index (int): the line's 0-based index.
            start (int): the line's byte offset.
            text (str): the line.
            matches (list[re.Match[str]]): the line's matches.
            is_match (bool): a selected line, not a context line.
        """
        f = self._f
        if not matches:
            yield self._record(index, None, start, text, [], is_match, True, 0)
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
        return encode_text(f"{head}{body}") + (b"\0" if f.null_data else b"\n")

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


def _selects(pat: re.Pattern[str], text: str, invert: bool) -> bool:
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
    lines: AsyncLineIterator, f: RgFlags, pat: re.Pattern[str]
) -> AsyncIterator[tuple[bytes, int, int]]:
    """Read records through the delimiter selected by rg, each with the
    records and bytes skipped before it.

    A record holding none of the pattern's needles cannot be selected, so
    it is skipped unless the output prints or stops at unselected records:
    -v, --stop-on-nonmatch, --passthru and printed context.

    Args:
        lines (AsyncLineIterator): The input cursor.
        f (RgFlags): The parsed flags.
        pat (re.Pattern[str]): The compiled line matcher.
    """
    needles = (
        None
        if f.invert or f.stop_on_nonmatch or f.passthru or prints_context(f)
        else required_needles(pat)
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
        yield raw, skipped, size


async def _listing(
    lines: AsyncLineIterator, pat: re.Pattern[str], f: RgFlags, tally: Tally
) -> None:
    """Read no further than the first selected line (-q, -l and
    --files-without-match need only that one bit).

    Args:
        lines (AsyncLineIterator): the haystack's lines.
        pat (re.Pattern[str]): the compiled pattern.
        f (RgFlags): the parsed flags.
        tally (Tally): receives the selection.
    """
    async for raw, _, _ in _records(lines, f, pat):
        if _selects(pat, decode_text(raw), f.invert):
            tally.selected = True
            return


async def _count(
    lines: AsyncLineIterator, pat: re.Pattern[str], f: RgFlags, tally: Tally
) -> int:
    """-c's selected lines, or --count-matches' matches, up to -m.

    Args:
        lines (AsyncLineIterator): the haystack's lines.
        pat (re.Pattern[str]): the compiled pattern.
        f (RgFlags): the parsed flags.
        tally (Tally): receives the selection.
    """
    count = 0
    selected = 0
    stop = nonmatch_stop(f)
    async for raw, _, _ in _records(lines, f, pat):
        text = decode_text(raw)
        if not _selects(pat, text, f.invert):
            if stop.armed:
                break
            stop.passes_over()
            continue
        stop.select()
        selected += 1
        tally.selected = True
        if f.only_matching and f.count_only:
            # -o -c counts matches, which an inverted selection has none
            # of, and still lists the input (ripgrep 14.1.1).
            if not f.invert:
                count += sum(1 for _ in rust_matches(pat, text))
        elif f.count_matches and not f.invert:
            count += sum(1 for _ in rust_matches(pat, text))
        else:
            count += 1
        if f.max_count is not None and selected >= f.max_count:
            break
    return count


async def _printed_lines(
    lines: AsyncLineIterator,
    printer: RgPrinter,
    pat: re.Pattern[str],
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
        pat (re.Pattern[str]): the compiled pattern.
        f (RgFlags): the parsed flags.
        tally (Tally): receives the selection.
        binary (RgBinary): the haystack's binary detection; a binary
            file prints its notice at the first selected line and
            nothing else.
        label (str | None): the path the notice leads with.
    """
    context = prints_context(f)
    held: deque[tuple[int, int, str]] = deque(
        maxlen=f.context_before if context else 0
    )
    budget = YieldBudget()
    index = -1
    position = 0
    selected = 0
    last_printed = -1
    after_left = 0
    stop = nonmatch_stop(f)
    async for raw, skipped, size in _records(lines, f, pat):
        index += skipped
        position += size
        index += 1
        start = position
        position += len(raw) + 1
        text = decode_text(raw)
        hit = _selects(pat, text, f.invert)
        if binary.offset is not None:
            if hit:
                tally.selected = True
                tally.binary = True
                yield binary.notice(label)
                return
            continue
        if not hit and stop.armed:
            # The line that stops the file still prints as the context
            # it is.
            if f.passthru or after_left > 0:
                for chunk in printer.context(index, start, text):
                    yield chunk
            return
        if not hit and stop.passes_over():
            if context:
                held.append((index, start, text))
            continue
        selecting = f.max_count is None or selected < f.max_count
        records: Iterable[bytes] = ()
        if hit and selecting:
            stop.select()
            selected += 1
            tally.selected = True
            if context:
                first = held[0][0] if held else index
                if (
                    last_printed >= 0
                    and first > last_printed + 1
                    and f.context_separator is not None
                ):
                    yield encode_text(f.context_separator) + (
                        b"\0" if f.null_data else b"\n"
                    )
                for i, s, t in held:
                    for chunk in printer.context(i, s, t):
                        yield chunk
                held.clear()
                after_left = f.context_after
            records = printer.selected(index, start, text)
            last_printed = index
        elif f.passthru:
            if not selecting:
                return
            records = printer.context(index, start, text)
            last_printed = index
        elif after_left > 0:
            records = (
                printer.selected(index, start, text)
                if hit
                else printer.context(index, start, text)
            )
            after_left -= 1
            last_printed = index
        elif context:
            held.append((index, start, text))
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


async def search_haystack(
    source: AsyncIterator[bytes],
    pat: re.Pattern[str],
    f: RgFlags,
    name: str,
    label: str | None,
    tally: Tally,
    named: bool = True,
    pipe: bool = False,
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
    """
    if f.max_count == 0:
        # ripgrep selects no line at all under -m0 and prints nothing,
        # count and listing included.
        await close_quietly(source)
        return
    binary = RgBinary(
        "text"
        if f.text or f.null_data
        else "convert"
        if named or f.binary
        else "quit"
    )
    reader = binary.read(source, pipe)
    lines = AsyncLineIterator(reader)
    try:
        if f.quiet or f.files_only or f.files_without_match:
            await _listing(lines, pat, f, tally)
            if binary.skipped:
                # A walked binary file was never searched, so it is in
                # neither listing.
                tally.skipped = True
                return
            if not f.quiet and tally.selected == f.files_only:
                yield encode_text(name) + (
                    b"\0" if f.null or f.null_data else b"\n"
                )
            return
        if f.count_only or f.count_matches:
            count = await _count(lines, pat, f, tally)
            if binary.skipped:
                return
            if tally.selected or f.include_zero:
                head = b""
                if label is not None:
                    head = encode_text(label) + (b"\0" if f.null else b":")
                yield (
                    head
                    + str(count).encode()
                    + (b"\0" if f.null_data else b"\n")
                )
            return
        printer = RgPrinter(f, pat, None if f.heading else label)
        async for chunk in _printed_lines(
            lines, printer, pat, f, tally, binary, label
        ):
            yield chunk
    except BaseException as exc:
        if not isinstance(exc, GeneratorExit):
            await discard_streams(source)
        raise
    finally:
        await close_quietly(reader)
        await close_quietly(source)
