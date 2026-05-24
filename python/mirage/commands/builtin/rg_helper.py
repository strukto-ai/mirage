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

import fnmatch
import posixpath
import re

from mirage.commands.builtin.grep_helper import (BINARY_EXTENSIONS,
                                                 compile_pattern,
                                                 get_extension, grep_lines)
from mirage.commands.builtin.utils.types import (_AsyncReadBytes,
                                                 _AsyncReaddir, _AsyncStat,
                                                 _ReadBytes)
from mirage.types import FileType

TYPE_EXTENSIONS: dict[str, list[str]] = {
    "py": [".py"],
    "js": [".js", ".jsx"],
    "ts": [".ts", ".tsx"],
    "java": [".java"],
    "go": [".go"],
    "rs": [".rs"],
    "rb": [".rb"],
    "c": [".c", ".h"],
    "cpp": [".cpp", ".hpp", ".cc", ".cxx"],
    "css": [".css"],
    "html": [".html", ".htm"],
    "json": [".json"],
    "yaml": [".yaml", ".yml"],
    "toml": [".toml"],
    "md": [".md"],
    "txt": [".txt"],
    "xml": [".xml"],
    "sql": [".sql"],
    "sh": [".sh", ".bash"],
    "csv": [".csv"],
}


def rg_matches_filter(
    entry: str,
    file_type: str | None,
    glob_pattern: str | None,
    hidden: bool,
) -> bool:
    basename = posixpath.basename(entry)
    if not hidden and basename.startswith("."):
        return False
    if file_type is not None:
        exts = TYPE_EXTENSIONS.get(file_type, [f".{file_type}"])
        if not any(entry.endswith(ext) for ext in exts):
            return False
    if glob_pattern is not None and not fnmatch.fnmatch(
            basename, glob_pattern):
        return False
    return True


def rg_search_file(
    read_bytes: _ReadBytes,
    entry: str,
    compiled: re.Pattern[str],
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    only_matching: bool,
    max_count: int | None,
    context_before: int,
    context_after: int,
    prefix_path: bool,
    warnings: list[str] | None = None,
) -> list[str]:
    try:
        data = read_bytes(entry).decode(errors="replace").splitlines()
    except Exception as exc:
        if warnings is not None:
            warnings.append(f"rg: {entry}: {exc}")
        return []

    if context_before == 0 and context_after == 0:
        lines = grep_lines(
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
        if prefix_path and not count_only and not files_only:
            return [f"{entry}:{ln}" for ln in lines]
        return lines

    results: list[str] = []
    match_indices: set[int] = set()
    count = 0
    for idx, line in enumerate(data):
        m = compiled.search(line)
        matched = bool(m) != invert
        if matched:
            count += 1
            match_indices.add(idx)
            if max_count is not None and count >= max_count:
                break

    if count_only:
        return [str(count)]
    if files_only:
        return [entry] if count > 0 else []

    output_indices: set[int] = set()
    for idx in sorted(match_indices):
        for j in range(max(0, idx - context_before),
                       min(len(data), idx + context_after + 1)):
            output_indices.add(j)

    prev_idx = -2
    pfx = f"{entry}:" if prefix_path else ""
    for idx in sorted(output_indices):
        if prev_idx >= 0 and idx > prev_idx + 1:
            results.append("--")
        line = data[idx]
        lineno = idx + 1
        is_match = idx in match_indices
        sep = ":" if is_match else "-"
        if line_numbers:
            results.append(f"{pfx}{lineno}{sep}{line}")
        else:
            results.append(f"{pfx}{line}")
        prev_idx = idx
    return results


async def rg_folder(
    readdir_fn: _AsyncReaddir,
    stat_fn: _AsyncStat,
    read_bytes_fn: _AsyncReadBytes,
    path: str,
    pattern: str,
    ignore_case: bool,
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    only_matching: bool,
    max_count: int | None,
    fixed_string: bool,
    whole_word: bool,
    file_type: str | None,
    glob_pattern: str | None,
    hidden: bool,
    warnings: list[str] | None,
) -> list[str]:
    results: list[str] = []
    try:
        entries = await readdir_fn(path)
    except (FileNotFoundError, ValueError) as exc:
        if warnings is not None:
            warnings.append(f"rg: {path}: {exc}")
        return results

    pat = compile_pattern(pattern, ignore_case, fixed_string, whole_word)

    for entry in entries:
        try:
            s = await stat_fn(entry)
        except (FileNotFoundError, ValueError) as exc:
            if warnings is not None:
                warnings.append(f"rg: {entry}: {exc}")
            continue

        if s.type == FileType.DIRECTORY:
            sub = await rg_folder(
                readdir_fn,
                stat_fn,
                read_bytes_fn,
                entry,
                pattern,
                ignore_case,
                invert,
                line_numbers,
                count_only,
                files_only,
                only_matching,
                max_count,
                fixed_string,
                whole_word,
                file_type,
                glob_pattern,
                hidden,
                warnings,
            )
            results.extend(sub)
            continue

        if get_extension(entry) in BINARY_EXTENSIONS:
            continue

        if not rg_matches_filter(entry, file_type, glob_pattern, hidden):
            continue

        try:
            raw = await read_bytes_fn(entry)
            text_lines = raw.decode(errors="replace").splitlines()
            for i_line, line in enumerate(text_lines, 1):
                m = pat.search(line)
                matched = bool(m) != invert
                if not matched:
                    continue
                if files_only:
                    results.append(entry)
                    break
                elif count_only:
                    pass
                elif only_matching and m and not invert:
                    pfx = (f"{i_line}:{m.group()}"
                           if line_numbers else m.group())
                    results.append(f"{entry}:{pfx}")
                else:
                    pfx = f"{i_line}:{line}" if line_numbers else line
                    results.append(f"{entry}:{pfx}")
        except Exception as exc:
            if warnings is not None:
                warnings.append(f"rg: {entry}: {exc}")

    return results


async def rg_full(
    readdir_fn: _AsyncReaddir,
    stat_fn: _AsyncStat,
    read_bytes_fn: _AsyncReadBytes,
    path: str,
    pattern: str,
    ignore_case: bool,
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    fixed_string: bool,
    only_matching: bool,
    max_count: int | None,
    whole_word: bool,
    context_before: int,
    context_after: int,
    file_type: str | None,
    glob_pattern: str | None,
    hidden: bool,
    warnings: list[str] | None,
) -> list[str]:
    compiled = compile_pattern(pattern, ignore_case, fixed_string, whole_word)

    is_dir = False
    try:
        s = await stat_fn(path)
        is_dir = s.type == FileType.DIRECTORY
    except (FileNotFoundError, ValueError):
        try:
            await readdir_fn(path)
            is_dir = True
        except (FileNotFoundError, ValueError):
            pass

    if not is_dir:
        if not rg_matches_filter(path, file_type, glob_pattern, hidden):
            return []
        try:
            data = (await
                    read_bytes_fn(path)).decode(errors="replace").splitlines()
        except Exception as exc:
            if warnings is not None:
                warnings.append(f"rg: {path}: {exc}")
            return []
        results: list[str] = []
        count = 0
        for i_ln, line in enumerate(data, 1):
            m = compiled.search(line)
            matched = bool(m) != invert
            if not matched:
                continue
            count += 1
            if files_only:
                return [path]
            if only_matching and m and not invert:
                text = m.group(0)
            else:
                text = line
            pfx = f"{i_ln}:{text}" if line_numbers else text
            results.append(pfx)
            if max_count is not None and count >= max_count:
                break
        if count_only:
            return [str(count)]
        return results

    results = []
    try:
        entries = await readdir_fn(path)
    except (FileNotFoundError, ValueError) as exc:
        if warnings is not None:
            warnings.append(f"rg: {path}: {exc}")
        return results

    for entry in entries:
        try:
            s = await stat_fn(entry)
        except (FileNotFoundError, ValueError) as exc:
            if warnings is not None:
                warnings.append(f"rg: {entry}: {exc}")
            continue

        if s.type == FileType.DIRECTORY:
            basename = posixpath.basename(entry)
            if not hidden and basename.startswith("."):
                continue
            results.extend(await rg_full(
                readdir_fn,
                stat_fn,
                read_bytes_fn,
                entry,
                pattern,
                ignore_case,
                invert,
                line_numbers,
                count_only,
                files_only,
                fixed_string,
                only_matching,
                max_count,
                whole_word,
                context_before,
                context_after,
                file_type,
                glob_pattern,
                hidden,
                warnings,
            ))
        else:
            if get_extension(entry) in BINARY_EXTENSIONS:
                continue
            if not rg_matches_filter(entry, file_type, glob_pattern, hidden):
                continue
            try:
                data = (await read_bytes_fn(entry)).decode(
                    errors="replace").splitlines()
                for i_ln, line in enumerate(data, 1):
                    m = compiled.search(line)
                    matched = bool(m) != invert
                    if not matched:
                        continue
                    if files_only:
                        results.append(entry)
                        break
                    if only_matching and m and not invert:
                        text = m.group(0)
                    else:
                        text = line
                    pfx = f"{i_ln}:{text}" if line_numbers else text
                    results.append(f"{entry}:{pfx}")
            except Exception as exc:
                if warnings is not None:
                    warnings.append(f"rg: {entry}: {exc}")
                continue

    return results
