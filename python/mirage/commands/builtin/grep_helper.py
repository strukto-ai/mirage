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
from collections.abc import AsyncIterator

from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.grep_context import grep_context_lines
from mirage.commands.builtin.utils.types import (_AsyncReadBytes,
                                                 _AsyncReaddir, _AsyncStat)
from mirage.commands.resolve import COMPOUND_EXTENSIONS
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.types import FileType

BINARY_EXTENSIONS = frozenset({
    ".parquet",
    ".orc",
    ".feather",
    ".arrow",
    ".ipc",
    ".hdf5",
    ".h5",
})


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
    if fixed_string:
        return PatternType.EXACT
    if re.fullmatch(r'[\w\s\-_.]+', pattern):
        return PatternType.SIMPLE
    return PatternType.REGEX


def compile_pattern(
    pattern: str,
    ignore_case: bool = False,
    fixed_string: bool = False,
    whole_word: bool = False,
) -> re.Pattern[str]:
    flags = re.IGNORECASE if ignore_case else 0
    pat_str = re.escape(pattern) if fixed_string else pattern
    if whole_word:
        pat_str = r"\b" + pat_str + r"\b"
    return re.compile(pat_str, flags)


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
    except (FileNotFoundError, ValueError) as exc:
        if warnings is not None:
            warnings.append(f"grep: {path}: {exc}")
        return results
    for entry in entries:
        try:
            s = await stat_fn(entry)
        except (FileNotFoundError, ValueError) as exc:
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
            except Exception as exc:
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
            except Exception as exc:
                if warnings is not None:
                    warnings.append(f"grep: {entry}: {exc}")
                continue
    return results


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
    warnings: list[str] | None,
    read_stream_fn=None,
) -> list[str]:
    compiled = compile_pattern(pattern, ignore_case, fixed_string, whole_word)

    if recursive:
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

    try:
        data = await read_bytes_fn(path)
        text_lines = data.decode(errors="replace").splitlines()
        count = 0
        for _i, line in enumerate(text_lines, 1):
            m = compiled.search(line)
            matched = bool(m) != invert
            if matched:
                count += 1
                if max_count is not None and count >= max_count:
                    break
        if count_only:
            return [str(count)]
        return [path] if count > 0 else []
    except (FileNotFoundError, ValueError, IsADirectoryError) as exc:
        if warnings is not None:
            warnings.append(f"grep: {path}: {exc}")

    try:
        s = await stat_fn(path)
        if s.type == FileType.DIRECTORY:
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
    except (FileNotFoundError, ValueError) as exc:
        if warnings is not None:
            warnings.append(f"grep: {path}: {exc}")
        try:
            await readdir_fn(path)
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
        except (FileNotFoundError, ValueError) as exc2:
            if warnings is not None:
                warnings.append(f"grep: {path}: {exc2}")

    return []
