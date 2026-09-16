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
from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.constants import BINARY_EXTENSIONS
from mirage.commands.builtin.grep_context import grep_context_lines
from mirage.commands.builtin.grep_offsets import (decode_line, encode_line,
                                                  line_offsets, match_offset,
                                                  prefix_of, printable)
from mirage.commands.builtin.grep_pattern import compile_pattern
from mirage.commands.builtin.grep_select import (NO_FILTERS, WalkFilters,
                                                 dir_admitted, file_admitted)
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.types import (AsyncReadBytes, AsyncReaddir,
                                                 AsyncStat)
from mirage.commands.resolve import get_extension
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType
from mirage.utils.errors import WALK_ERRORS, fs_strerror


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
            as a line is selected. The twin of ``grep_stream``'s own
            ``io``, and needed for the same reason: selection cannot be
            read off the returned list under -o, because GNU prints
            nothing for a zero-width match and still counts the line, so
            a caller deriving the status from an empty list reports 1
            where GNU says 0.
        byte_offsets (bool): -b, prefix each printed line with the byte
            offset of its own start, or of the match itself under -o.
            The offsets are derived from the lines because this scan is
            handed text rather than bytes, which is exact only for text
            that came through ``decode_line``.

    Returns:
        list[str]: the lines to print, the count under -c, or the path
            under -l.
    """
    if max_count == 0:
        # GNU selects no line at all and the whole command goes quiet:
        # `grep -m0 -c a f` prints NOTHING, not `0`, and exits 1. An empty
        # list is what -c has to answer with, because `grep_recursive`
        # renders `<file>:<count>` from whatever comes back and GNU prints
        # no per-file zeros under -m0 either. Read before the loop rather
        # than after a line is printed, because `count >= 0` is already
        # true and the bottom check would let the first selected line out
        # first. `grep_input` takes the same early return.
        return []
    results: list[str] = []
    count = 0
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
        if not count_only and not files_only:
            if only_matching:
                # GNU -o prints every match on the line, one per line, and
                # prints nothing at all for an empty match nor for an
                # inverted selection, which has no match to print
                # (`grep -ov abc` is zero bytes and exit 0 where GNU's own
                # -c still says 1). The line is still selected, so `count`
                # is already incremented above and -c, -l and the exit
                # status see it.
                if not invert:
                    for found in compiled.finditer(line):
                        text = found.group(0)
                        if not text:
                            continue
                        results.append(
                            prefix_of(
                                i if line_numbers else None,
                                match_offset(start, line, found.start(
                                )) if byte_offsets else None) + text)
            else:
                results.append(
                    prefix_of(i if line_numbers else None,
                              start if byte_offsets else None) + line)
        if max_count is not None and count >= max_count:
            break
    if count_only:
        return [str(count)]
    if files_only:
        return [path] if count > 0 else []
    return [printable(r) for r in results]


def _grep_count_value(results: list[str]) -> int:
    """Return the numeric value from count-only grep results.

    Args:
        results (list[str]): `grep_lines(..., count_only=True)` output.

    Returns:
        int: The parsed match count, or zero when the result is empty.
    """
    if not results:
        return 0
    return int(results[0])


def grep_count_has_matches(results: list[str]) -> bool:
    """Return whether count-only grep results contain any matches.

    Args:
        results (list[str]): `grep_lines(..., count_only=True)` output.

    Returns:
        bool: True when the parsed count is greater than zero.
    """
    return _grep_count_value(results) > 0


async def prefix_lines(source: AsyncIterator[bytes],
                       prefix: str) -> AsyncIterator[bytes]:
    """Prefix every line chunk with a filename label (grep -H).

    Args:
        source (AsyncIterator[bytes]): grep stream yielding one line per
            chunk.
        prefix (str): Label including the separator, e.g. ``file.txt:``.
    """
    encoded = prefix.encode()
    async for chunk in source:
        yield encoded + chunk


async def nonzero_count_stream(
        source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Drop zero-count chunks for `rg -c` fallback streams.

    Args:
        source (AsyncIterator[bytes]): Count-only grep stream.

    Yields:
        bytes: Count chunks whose parsed value is greater than zero.
    """
    async for chunk in source:
        count = int(chunk.decode(errors="replace").strip() or "0")
        if count > 0:
            yield chunk


def count_records_have_matches(results: list[str]) -> bool:
    """Return whether any `path:count` record has a nonzero count.

    Args:
        results (list[str]): Count-only records in `path:count` form.

    Returns:
        bool: True when any parsed count is greater than zero.
    """
    return any(int(r.rsplit(":", 1)[-1]) > 0 for r in results)


async def count_exit_stream(
    source: AsyncIterator[bytes],
    io: IOResult,
) -> AsyncIterator[bytes]:
    """Yield count-only grep output, setting exit 1 when all counts are zero.

    GNU grep -c prints the count but still exits 1 when no lines were
    selected, so emptiness-based exit detection cannot apply.

    Args:
        source (AsyncIterator[bytes]): Count-only grep stream.
        io (IOResult): Result whose exit_code becomes 1 when nothing matched.

    Yields:
        bytes: The unchanged count chunks.
    """
    any_match = False
    async for chunk in source:
        if int(chunk.decode(errors="replace").strip() or "0") > 0:
            any_match = True
        yield chunk
    if not any_match:
        io.exit_code = 1


async def grep_stream(
    source: AsyncIterator[bytes],
    pat: re.Pattern[str],
    invert: bool = False,
    line_numbers: bool = False,
    only_matching: bool = False,
    max_count: int | None = None,
    count_only: bool = False,
    after_context: int = 0,
    before_context: int = 0,
    io: IOResult | None = None,
    byte_offsets: bool = False,
) -> AsyncIterator[bytes]:
    """Stream grep's output for one input.

    Args:
        source (AsyncIterator[bytes]): the input's bytes.
        pat (re.Pattern[str]): the compiled pattern.
        invert (bool): -v, select the lines that do not match.
        line_numbers (bool): -n, prefix each printed line with its
            number.
        only_matching (bool): -o, print the matched text rather than the
            line.
        max_count (int | None): -m, stop after this many selected lines.
        count_only (bool): -c, print the number of selected lines.
        after_context (int): -A, trailing context lines.
        before_context (int): -B, leading context lines.
        io (IOResult | None): when given, receives exit status 0 as soon
            as a line is selected. Selection cannot be read off the
            output for -o, because GNU prints nothing for a zero-width
            match and still counts the line, so a caller that derives
            the status from an empty stream reports 1 where GNU says 0.
        byte_offsets (bool): -b, prefix each printed line with the byte
            offset of its own start, or of the match itself under -o.
    """
    if max_count == 0:
        # GNU selects no line at all, context and all, and prints nothing
        # for it: `grep -m0 -c a f` is zero bytes and exit 1, not `0`.
        # Read before anything else because `match_count >= 0` is already
        # true, so the per-line check below would let the first selected
        # line out first. `grep_input` and `grep_lines` take the same
        # early return.
        return
    has_context = after_context > 0 or before_context > 0
    if has_context and not count_only and not only_matching:
        all_lines: list[str] = []
        async for raw_line in AsyncLineIterator(source):
            all_lines.append(decode_line(raw_line))
        for chunk in grep_context_lines(
                all_lines,
                pat,
                invert,
                line_numbers,
                max_count,
                after_context,
                before_context,
                byte_offsets,
        ):
            if io is not None:
                io.exit_code = 0
            yield chunk
        return
    match_count = 0
    line_num = 0
    # GNU counts bytes from the start of the input, the terminator the
    # iterator strips included; the byte past a final unterminated line is
    # never read.
    byte_pos = 0
    async for raw_line in AsyncLineIterator(source):
        line_num += 1
        line_start = byte_pos
        byte_pos += len(raw_line) + 1
        line = decode_line(raw_line)
        hit = bool(pat.search(line))
        if invert:
            hit = not hit
        if not hit:
            continue
        # The count is per selected LINE, never per match, which is what
        # makes `grep -oc '[0-9]*'` on `ab` answer 1 the way GNU does:
        # the empty match selects the line even though -o prints nothing
        # for it. -m counts selected lines for the same reason.
        match_count += 1
        if io is not None:
            io.exit_code = 0
        if not count_only:
            if only_matching:
                # Nothing is printed for an inverted selection, which has
                # no match to print: `grep -ov abc` is zero bytes where
                # GNU's own -c still says 1.
                if not invert:
                    for m in pat.finditer(line):
                        text = m.group()
                        if not text:
                            continue
                        fields = prefix_of(
                            line_num if line_numbers else None,
                            match_offset(line_start, line, m.start())
                            if byte_offsets else None)
                        yield encode_line(f"{fields}{text}\n")
            elif line_numbers or byte_offsets:
                fields = prefix_of(line_num if line_numbers else None,
                                   line_start if byte_offsets else None)
                yield encode_line(f"{fields}{line}\n")
            else:
                yield raw_line + b"\n"
        if max_count is not None and match_count >= max_count:
            if count_only:
                yield str(match_count).encode() + b"\n"
            return
    if count_only:
        yield str(match_count).encode() + b"\n"


async def grep_recursive(
    readdir_fn: AsyncReaddir,
    stat_fn: AsyncStat,
    read_bytes_fn: AsyncReadBytes,
    path: str,
    compiled: re.Pattern[str],
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    only_matching: bool,
    max_count: int | None,
    warnings: list[str] | None = None,
    read_stream_fn: Callable[[str], AsyncIterator[bytes]] | None = None,
    filters: WalkFilters = NO_FILTERS,
    byte_offsets: bool = False,
) -> list[str]:
    results: list[str] = []
    try:
        entries = await readdir_fn(path)
    except WALK_ERRORS as exc:
        if warnings is not None:
            warnings.append(f"grep: {path}: {fs_strerror(exc) or exc}")
        return results
    for entry in entries:
        try:
            s = await stat_fn(entry)
        except WALK_ERRORS as exc:
            if warnings is not None:
                warnings.append(f"grep: {entry}: {fs_strerror(exc) or exc}")
            continue
        if s.type == FileType.DIRECTORY:
            if not dir_admitted(entry, filters):
                continue
            results.extend(await grep_recursive(
                readdir_fn,
                stat_fn,
                read_bytes_fn,
                entry,
                compiled,
                invert,
                line_numbers,
                count_only,
                files_only,
                only_matching,
                max_count,
                warnings,
                read_stream_fn,
                filters,
                byte_offsets,
            ))
            continue
        if s.type is not FileType.FILE:
            # Recursive grep follows filesystem entries, but only regular
            # files are search candidates. Devices must not be whole-read.
            continue
        if not file_admitted(entry, filters):
            continue
        if not filters.text and get_extension(entry) in BINARY_EXTENSIONS:
            continue
        if read_stream_fn is not None:
            try:
                source = read_stream_fn(entry)
                file_results: list[str] = []
                async for chunk in grep_stream(
                        source,
                        compiled,
                        invert=invert,
                        line_numbers=line_numbers,
                        only_matching=only_matching,
                        max_count=max_count,
                        count_only=count_only,
                        byte_offsets=byte_offsets,
                ):
                    file_results.append(
                        chunk.decode(errors="replace").rstrip("\n"))
                if count_only:
                    if file_results:
                        results.append(f"{entry}:{file_results[0]}")
                elif files_only:
                    if file_results:
                        results.append(entry)
                else:
                    results.extend(f"{entry}:{r}" for r in file_results)
            except WALK_ERRORS as exc:
                if warnings is not None:
                    warnings.append(
                        f"grep: {entry}: {fs_strerror(exc) or exc}")
                continue
        else:
            try:
                data = split_lines(decode_line(await read_bytes_fn(entry)))
                file_results = grep_lines(
                    entry,
                    data,
                    compiled,
                    invert,
                    line_numbers,
                    count_only,
                    files_only,
                    only_matching,
                    max_count,
                    byte_offsets=byte_offsets,
                )
                if count_only:
                    if file_results:
                        results.append(f"{entry}:{file_results[0]}")
                elif files_only:
                    results.extend(file_results)
                else:
                    results.extend(f"{entry}:{r}" for r in file_results)
            except WALK_ERRORS as exc:
                if warnings is not None:
                    warnings.append(
                        f"grep: {entry}: {fs_strerror(exc) or exc}")
                continue
    return results


async def _operand_is_directory(
    readdir_fn: AsyncReaddir,
    info: FileStat | None,
    path: str,
) -> bool:
    """Whether an operand names a directory, asked on both channels.

    Both channels are consulted because on a prefix store a directory is
    the set of keys under it rather than an object, so stat misses one
    that readdir lists happily. The listing has to be non-empty to count:
    such a store answers readdir for any path at all, returning nothing
    for one that does not exist, so a bare "it did not raise" reads every
    missing file as a directory. The cost is that a genuinely empty
    directory is invisible there, which is the same thing ``du`` already
    documents and the safer way round: naming a missing file is a report
    a caller can act on, calling it a directory is not.

    Args:
        readdir_fn (AsyncReaddir): backend directory reader.
        info (FileStat | None): what stat said, None when it could not
            answer.
        path (str): the operand path.

    Returns:
        bool: True when either channel reports a directory.
    """
    if info is not None:
        return info.type is FileType.DIRECTORY
    try:
        return bool(await readdir_fn(path))
    except WALK_ERRORS:
        return False


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


def _operand_error(path: str, exc: BaseException) -> str:
    """GNU's stderr line for an operand grep could not read.

    A directory does not reach here: it is recognized from its type
    before the read, because what a read raises for one is whatever the
    backend happens to do about it.

    Args:
        path (str): the operand as it was named.
        exc (BaseException): what the read raised.

    Returns:
        str: the `grep: <path>: <reason>` line, without a trailing newline.
    """
    return f"grep: {path}: {fs_strerror(exc) or exc}"


async def grep_files_only(
    readdir_fn: AsyncReaddir,
    stat_fn: AsyncStat,
    read_bytes_fn: AsyncReadBytes,
    path: str,
    pattern: str,
    recursive: bool,
    ignore_case: bool,
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    fixed_string: bool,
    only_matching: bool,
    max_count: int | None,
    whole_word: bool,
    basic: bool,
    warnings: list[str] | None,
    read_stream_fn: Callable[[str], AsyncIterator[bytes]] | None = None,
    filters: WalkFilters = NO_FILTERS,
    byte_offsets: bool = False,
) -> list[str]:
    compiled = compile_pattern(pattern, ignore_case, fixed_string, whole_word,
                               basic)

    # What the operand is, asked before it is read. A failed read is a
    # backend-dependent proxy for the type and a poor one: a keyed store
    # reads a directory path without complaint and returns nothing, and
    # ssh answers with an SFTP error that is not an OSError at all, so
    # classifying afterwards gets a different answer per backend.
    info: FileStat | None = None
    try:
        info = await stat_fn(path)
    except WALK_ERRORS:
        info = None

    if recursive:
        # GNU only walks directory operands; a file operand under -r takes
        # the plain single-file scan (TS grepGeneric parity). Stat failures
        # keep the walk so missing operands surface its error shape.
        operand_is_file = info is not None and info.type != FileType.DIRECTORY
        if not operand_is_file:
            return await grep_recursive(
                readdir_fn,
                stat_fn,
                read_bytes_fn,
                path,
                compiled,
                invert,
                line_numbers,
                count_only,
                True,
                only_matching,
                max_count,
                warnings,
                read_stream_fn,
                filters,
                byte_offsets,
            )

    # GNU names a directory operand and moves on without descending into
    # it; only -r walks one, and that branch returned above. Walking here
    # would make -l alone behave like -rl.
    if await _operand_is_directory(readdir_fn, info, path):
        if warnings is not None:
            warnings.append(f"grep: {path}: Is a directory")
        return []

    if not file_admitted(path, filters):
        return []

    try:
        data = await read_bytes_fn(path)
    except WALK_ERRORS as exc:
        if warnings is not None:
            warnings.append(_operand_error(path, exc))
        return []
    text_lines = split_lines(decode_line(data))
    if max_count == 0:
        # GNU selects no line, so -l names nothing and -c prints nothing
        # rather than a zero.
        return []
    count = 0
    for line in text_lines:
        if bool(compiled.search(line)) != invert:
            count += 1
            if max_count is not None and count >= max_count:
                break
    if count_only:
        return [str(count)]
    return [path] if count > 0 else []
