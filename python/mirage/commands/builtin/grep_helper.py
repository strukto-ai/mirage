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
from collections.abc import (AsyncIterator, Awaitable, Callable, Mapping,
                             Sequence)

from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.grep_context import grep_context_lines
from mirage.commands.builtin.utils.types import (_AsyncReadBytes,
                                                 _AsyncReaddir, _AsyncStat)
from mirage.commands.builtin.utils.wrap import call_read_bytes
from mirage.commands.errors import UsageError
from mirage.commands.resolve import COMPOUND_EXTENSIONS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.bre import bre_to_python
from mirage.utils.errors import WALK_ERRORS
from mirage.utils.key_prefix import mount_prefix_of

BINARY_EXTENSIONS = frozenset({
    ".parquet",
    ".orc",
    ".feather",
    ".arrow",
    ".ipc",
    ".hdf5",
    ".h5",
})

NEVER_MATCH = r"(?!)"


def classify_pattern(
    pattern: str,
    fixed_string: bool,
) -> PatternType:
    """Classify a grep pattern for API push-down decisions.

    Args:
        pattern (str): the search pattern.
        fixed_string (bool): True if -F flag is set.

    Returns:
        PatternType: EXACT, SIMPLE, or REGEX.
    """
    if "\n" in pattern:
        return PatternType.REGEX
    if fixed_string:
        return PatternType.EXACT
    if re.fullmatch(r'[\w\s\-_.]+', pattern):
        return PatternType.SIMPLE
    return PatternType.REGEX


_REGEX_BREAKERS = frozenset(".^$*+?()|{}")
_MIN_SEARCH_LITERAL = 3


def extract_required_literal(pattern: str) -> str | None:
    """Longest substring every match of a regex must contain.

    Returns a literal that any line matching ``pattern`` is guaranteed to
    contain, suitable for narrowing via a literal search API before the real
    regex is scanned locally. Conservative: returns None whenever a required
    literal cannot be proven (top-level alternation, character classes,
    escapes, runs shorter than ``_MIN_SEARCH_LITERAL``), so the caller falls
    back to a full scan rather than risk a false negative.

    Args:
        pattern (str): a regular expression.

    Returns:
        str | None: the longest required literal, or None.
    """
    if "|" in pattern:
        return None
    runs: list[str] = []
    current: list[str] = []
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "\\":
            runs.append("".join(current))
            current = []
            i += 2
            continue
        if ch == "[":
            runs.append("".join(current))
            current = []
            i += 1
            while i < n and pattern[i] != "]":
                i += 2 if pattern[i] == "\\" else 1
            i += 1
            continue
        if ch in _REGEX_BREAKERS:
            if ch in "*?{" and current:
                current.pop()
            runs.append("".join(current))
            current = []
            if ch == "{":
                while i < n and pattern[i] != "}":
                    i += 1
            i += 1
            continue
        current.append(ch)
        i += 1
    runs.append("".join(current))
    best = max(runs, key=len, default="")
    return best if len(best) >= _MIN_SEARCH_LITERAL else None


def is_literal_pattern(pattern: str, fixed_string: bool) -> bool:
    """Whether the pattern is searched verbatim, with no regex extraction.

    Push-down against a whole-word search index is only complete when the term
    handed to the provider is the entire match. A regex narrowed on an
    extracted literal fails that: ``foo[0-9]`` under -w matches ``foo1``, but a
    whole-word search for ``foo`` never returns a file whose only token is
    ``foo1``.

    Args:
        pattern (str): the search pattern.
        fixed_string (bool): True if -F is set.

    Returns:
        bool: True when the pattern itself is the search term.
    """
    if fixed_string:
        return True
    pt = classify_pattern(pattern, fixed_string)
    return pt == PatternType.EXACT or (pt == PatternType.SIMPLE
                                       and "." not in pattern)


def search_query(pattern: str, fixed_string: bool) -> str | None:
    """Literal to push down to a code-search API for a grep/rg pattern.

    Args:
        pattern (str): the search pattern.
        fixed_string (bool): True if -F is set.

    Returns:
        str | None: the pattern itself when it is literal, a required literal
            extracted from a regex, or None when no literal can be searched.
    """
    if classify_pattern(pattern, fixed_string) != PatternType.REGEX:
        return pattern
    return extract_required_literal(pattern)


_PUSHDOWN_SHAPING_BOOL = ("v", "n", "c", "args_l", "w", "o", "q", "H", "h",
                          "args_I")
_PUSHDOWN_SHAPING_INT = ("m", "A", "B", "C")
_PUSHDOWN_FILTER_STR = ("type", "glob")


def has_search_shaping_flags(flags: Mapping[str, FlagValue] | None) -> bool:
    """True when a flag alters the match set or output shape of grep/rg.

    A search push-down prints each matching record as one whole line, so it
    cannot honor -v/-n/-c/-l/-w/-o/-m/-A/-B/-C/-q/-H/-h, rg's -I (no filename),
    nor rg's file-filtering --glob/--type; when any is present the wrapper must
    defer to the generic scan, which applies exact semantics. Reads through a
    spec-less FlagView so the shared key set works for both the grep and rg
    specs (rg simply never sets the grep-only keys).

    Args:
        flags (Mapping[str, FlagValue] | None): raw flag kwargs.
    """
    fl = FlagView(flags)
    if any(fl.as_bool(k) for k in _PUSHDOWN_SHAPING_BOOL):
        return True
    if any(fl.as_int(k) is not None for k in _PUSHDOWN_SHAPING_INT):
        return True
    return any(fl.as_str(k) is not None for k in _PUSHDOWN_FILTER_STR)


def search_pushdown_ok(flags: Mapping[str, FlagValue] | None,
                       pattern: str) -> bool:
    """True when a literal-substring push-down faithfully reproduces grep/rg.

    For the LIKE/ILIKE substring push-down (postgres/mysql), faithful means a
    literal pattern with no shaping flags; a real regex is treated literally
    by LIKE and so must take the generic scan, and a newline-joined pattern
    list (-F with multiple -e) is a set of independent alternatives that LIKE
    cannot express. Backends that push a real regex down (mongodb) gate on
    has_search_shaping_flags alone instead.

    Args:
        flags (Mapping[str, FlagValue] | None): raw flag kwargs.
        pattern (str): the resolved search pattern.
    """
    if "\n" in pattern:
        return False
    fl = FlagView(flags)
    return (is_literal_pattern(pattern, fl.as_bool("F"))
            and not has_search_shaping_flags(flags))


def pattern_arg(texts: Sequence[str], flags: FlagView) -> str | None:
    """Resolve the pattern-list argument from -e values or the positional.

    Args:
        texts (Sequence[str]): positional TEXT operands.
        flags (FlagView): typed view over raw flag kwargs.

    Returns:
        str | None: POSIX newline-joined pattern list (each -e value may
            itself be a newline-separated list), or None when neither -e nor
            a positional pattern was supplied.
    """
    e_values = flags.as_list("e")
    if e_values:
        return "\n".join(e_values)
    if texts:
        return texts[0]
    return None


async def resolve_pattern(
    texts: Sequence[str],
    flags: FlagView,
    read_bytes: Callable[[PathSpec], Awaitable[bytes]],
    usage: str,
) -> tuple[str, bool]:
    """Resolve the search pattern from -e/positional/-f flag arguments.

    Args:
        texts (Sequence[str]): positional TEXT operands.
        flags (FlagView): typed view over raw flag kwargs.
        read_bytes (Callable[[PathSpec], Awaitable[bytes]]): bound
            whole-file reader used for -f pattern files.
        usage (str): usage error message when no pattern was supplied.

    Returns:
        tuple[str, bool]: (newline-separated pattern list, never_match) where
            never_match is True when -f supplied zero patterns (GNU: match
            nothing; -F escaping must be skipped for the sentinel).
    """
    pattern = pattern_arg(texts, flags)

    pattern_file = flags.raw("f")
    if isinstance(pattern_file, (PathSpec, list)):
        raw = (pattern_file
               if isinstance(pattern_file, list) else [pattern_file])
        for pf in [item for item in raw if isinstance(item, PathSpec)]:
            file_data = await call_read_bytes(read_bytes,
                                              pf,
                                              prefix=mount_prefix_of(
                                                  pf.virtual,
                                                  pf.resource_path))
            pattern = merge_pattern_list(pattern, file_data)
        if pattern is None:
            return NEVER_MATCH, True
    if pattern is None:
        raise UsageError(usage)
    return pattern, False


def merge_pattern_list(
    pattern: str | None,
    file_data: bytes | None,
) -> str | None:
    """Merge a pattern list with the content of a -f pattern file.

    Args:
        pattern (str | None): newline-separated pattern list from -e or the
            positional argument, or None when only -f supplied patterns.
        file_data (bytes | None): raw -f file content, or None without -f.

    Returns:
        str | None: merged newline-separated pattern list, or None when the
            list is empty (GNU: zero patterns match nothing).
    """
    parts: list[str] = [] if pattern is None else pattern.split("\n")
    if file_data:
        text = file_data.decode(errors="replace")
        if text.endswith("\n"):
            text = text[:-1]
        parts.extend(text.split("\n"))
    if not parts:
        return None
    return "\n".join(parts)


def _source_of(part: str, fixed_string: bool, basic: bool) -> str:
    """One pattern's regex source, in the syntax it was written in.

    Args:
        part (str): a single pattern from the list.
        fixed_string (bool): True if -F flag is set.
        basic (bool): True when the pattern is a basic regular
            expression (grep's default), False for an extended one.
    """
    if fixed_string:
        return re.escape(part)
    return bre_to_python(part) if basic else part


def build_pattern_str(
    pattern: str,
    fixed_string: bool = False,
    whole_word: bool = False,
    basic: bool = False,
) -> str:
    """Build a regex source string from a POSIX pattern list.

    Args:
        pattern (str): newline-separated pattern list; a line matches when
            any of the patterns matches.
        fixed_string (bool): True if -F flag is set.
        whole_word (bool): True if -w flag is set.
        basic (bool): True when the patterns are basic regular
            expressions, which grep reads by default and which invert
            most of Python's operators. False leaves them alone, which
            is right for -E and for rg's own dialect.

    Returns:
        str: regex source string.
    """
    parts = pattern.split("\n")
    if len(parts) == 1:
        pat_str = _source_of(pattern, fixed_string, basic)
        if whole_word:
            pat_str = r"\b" + pat_str + r"\b"
        return pat_str
    subs: list[str] = []
    for part in parts:
        source = _source_of(part, fixed_string, basic)
        sub = source if fixed_string else f"(?:{source})"
        if whole_word:
            sub = r"\b" + sub + r"\b"
        subs.append(sub)
    return "|".join(subs)


def compile_pattern(
    pattern: str,
    ignore_case: bool = False,
    fixed_string: bool = False,
    whole_word: bool = False,
    basic: bool = False,
) -> re.Pattern[str]:
    """Compile a pattern list into one matcher.

    Args:
        pattern (str): newline-separated pattern list.
        ignore_case (bool): True if -i flag is set.
        fixed_string (bool): True if -F flag is set.
        whole_word (bool): True if -w flag is set.
        basic (bool): True for a basic regular expression.
    """
    flags = re.IGNORECASE if ignore_case else 0
    return re.compile(
        build_pattern_str(pattern, fixed_string, whole_word, basic), flags)


def get_extension(path: str) -> str | None:
    basename = path.rsplit("/", 1)[-1]
    for ext in COMPOUND_EXTENSIONS:
        if basename.endswith(ext):
            return ext
    dot = path.rfind(".")
    if dot == -1 or "/" in path[dot:]:
        return None
    return path[dot:]


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
) -> list[str]:
    results: list[str] = []
    count = 0
    for i, line in enumerate(data, 1):
        m = compiled.search(line)
        matched = bool(m) != invert
        if not matched:
            continue
        count += 1
        if not count_only and not files_only:
            if only_matching and m and not invert:
                text = m.group(0)
            else:
                text = line
            prefix = f"{i}:{text}" if line_numbers else text
            results.append(prefix)
        if max_count is not None and count >= max_count:
            break
    if count_only:
        return [str(count)]
    if files_only:
        return [path] if count > 0 else []
    return results


def grep_count_value(results: list[str]) -> int:
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
    return grep_count_value(results) > 0


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
) -> AsyncIterator[bytes]:
    has_context = after_context > 0 or before_context > 0
    if has_context and not count_only and not only_matching:
        all_lines: list[str] = []
        async for raw_line in AsyncLineIterator(source):
            all_lines.append(raw_line.decode(errors="replace"))
        for chunk in grep_context_lines(
                all_lines,
                pat,
                invert,
                line_numbers,
                max_count,
                after_context,
                before_context,
        ):
            yield chunk
        return
    match_count = 0
    line_num = 0
    async for raw_line in AsyncLineIterator(source):
        line_num += 1
        line = raw_line.decode(errors="replace")
        hit = bool(pat.search(line))
        if invert:
            hit = not hit
        if not hit:
            continue
        if only_matching and not invert:
            for m in pat.finditer(line):
                match_count += 1
                if not count_only:
                    yield m.group().encode() + b"\n"
                if max_count and match_count >= max_count:
                    if count_only:
                        yield str(match_count).encode() + b"\n"
                    return
        else:
            match_count += 1
            if not count_only:
                if line_numbers:
                    yield f"{line_num}:{line}\n".encode()
                else:
                    yield raw_line + b"\n"
            if max_count and match_count >= max_count:
                if count_only:
                    yield str(match_count).encode() + b"\n"
                return
    if count_only:
        yield str(match_count).encode() + b"\n"


async def grep_recursive(
    readdir_fn: _AsyncReaddir,
    stat_fn: _AsyncStat,
    read_bytes_fn: _AsyncReadBytes,
    path: str,
    compiled: re.Pattern[str],
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    only_matching: bool,
    max_count: int | None,
    warnings: list[str] | None = None,
    read_stream_fn=None,
) -> list[str]:
    results: list[str] = []
    try:
        entries = await readdir_fn(path)
    except WALK_ERRORS as exc:
        if warnings is not None:
            warnings.append(f"grep: {path}: {exc}")
        return results
    for entry in entries:
        try:
            s = await stat_fn(entry)
        except WALK_ERRORS as exc:
            if warnings is not None:
                warnings.append(f"grep: {entry}: {exc}")
            continue
        if s.type == FileType.DIRECTORY:
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
            ))
            continue
        if get_extension(entry) in BINARY_EXTENSIONS:
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
                    warnings.append(f"grep: {entry}: {exc}")
                continue
        else:
            try:
                data = (await read_bytes_fn(entry)).decode(
                    errors="replace").splitlines()
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
                    warnings.append(f"grep: {entry}: {exc}")
                continue
    return results


async def operand_is_directory(
    readdir_fn: _AsyncReaddir,
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
        readdir_fn (_AsyncReaddir): backend directory reader.
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


def operand_error(path: str, exc: BaseException) -> str:
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
    if isinstance(exc, FileNotFoundError):
        return f"grep: {path}: No such file or directory"
    return f"grep: {path}: {exc}"


async def grep_files_only(
    readdir_fn: _AsyncReaddir,
    stat_fn: _AsyncStat,
    read_bytes_fn: _AsyncReadBytes,
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
    read_stream_fn=None,
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
            )

    # GNU names a directory operand and moves on without descending into
    # it; only -r walks one, and that branch returned above. Walking here
    # would make -l alone behave like -rl.
    if await operand_is_directory(readdir_fn, info, path):
        if warnings is not None:
            warnings.append(f"grep: {path}: Is a directory")
        return []

    try:
        data = await read_bytes_fn(path)
    except WALK_ERRORS as exc:
        if warnings is not None:
            warnings.append(operand_error(path, exc))
        return []
    text_lines = data.decode(errors="replace").splitlines()
    count = 0
    for line in text_lines:
        if bool(compiled.search(line)) != invert:
            count += 1
            if max_count is not None and count >= max_count:
                break
    if count_only:
        return [str(count)]
    return [path] if count > 0 else []
