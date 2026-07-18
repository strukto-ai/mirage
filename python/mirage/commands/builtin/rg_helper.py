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

from mirage.commands.builtin.grep_context import grep_context_lines
from mirage.commands.builtin.grep_helper import (BINARY_EXTENSIONS,
                                                 compile_pattern,
                                                 get_extension)
from mirage.commands.builtin.utils.types import (_AsyncReadBytes,
                                                 _AsyncReaddir, _AsyncStat)
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
            file_count = 0
            for i_line, line in enumerate(text_lines, 1):
                m = pat.search(line)
                matched = bool(m) != invert
                if not matched:
                    continue
                file_count += 1
                if files_only:
                    results.append(entry)
                    break
                elif count_only:
                    if max_count is not None and file_count >= max_count:
                        break
                elif only_matching and m and not invert:
                    pfx = (f"{i_line}:{m.group()}"
                           if line_numbers else m.group())
                    results.append(f"{entry}:{pfx}")
                else:
                    pfx = f"{i_line}:{line}" if line_numbers else line
                    results.append(f"{entry}:{pfx}")
            if count_only and file_count > 0:
                results.append(f"{entry}:{file_count}")
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
    file_prefix: str | None = None,
    no_filename: bool = False,
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
            # not a directory (or vanished): treat the operand as a file
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
        if ((context_before or context_after) and not files_only
                and not count_only and not only_matching
                and file_prefix is None):
            # Single-file context rides the shared grep renderer (match
            # lines `N:`, context lines `N-`, `--` between groups).
            # Directory search and filename-prefixed fanout skip context,
            # mirroring grep's -H divergence.
            rendered = grep_context_lines(data, compiled, invert, line_numbers,
                                          max_count, context_after,
                                          context_before)
            return [b.decode().rstrip("\n") for b in rendered]
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
            if file_prefix is not None:
                pfx = f"{file_prefix}:{pfx}"
            results.append(pfx)
            if max_count is not None and count >= max_count:
                break
        if count_only:
            if count == 0:
                return []
            return [f"{file_prefix}:{count}"
                    ] if file_prefix is not None else [str(count)]
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
                no_filename=no_filename,
            ))
        else:
            if get_extension(entry) in BINARY_EXTENSIONS:
                continue
            if not rg_matches_filter(entry, file_type, glob_pattern, hidden):
                continue
            try:
                data = (await read_bytes_fn(entry)).decode(
                    errors="replace").splitlines()
                file_count = 0
                for i_ln, line in enumerate(data, 1):
                    m = compiled.search(line)
                    matched = bool(m) != invert
                    if not matched:
                        continue
                    file_count += 1
                    if files_only:
                        results.append(entry)
                        break
                    if count_only:
                        if max_count is not None and file_count >= max_count:
                            break
                        continue
                    if only_matching and m and not invert:
                        text = m.group(0)
                    else:
                        text = line
                    pfx = f"{i_ln}:{text}" if line_numbers else text
                    # ripgrep -I drops per-file labels in directory walks.
                    results.append(pfx if no_filename else f"{entry}:{pfx}")
                if count_only and file_count > 0:
                    results.append(
                        str(file_count
                            ) if no_filename else f"{entry}:{file_count}")
            except Exception as exc:
                if warnings is not None:
                    warnings.append(f"rg: {entry}: {exc}")
                continue

    return results
