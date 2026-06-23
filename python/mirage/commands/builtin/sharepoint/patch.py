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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.sharepoint.glob import resolve_glob
from mirage.core.sharepoint.read import read_bytes
from mirage.core.sharepoint.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _strip_path(path: str, strip_count: int) -> str:
    parts = path.split("/")
    return "/".join(
        parts[strip_count:]) if strip_count < len(parts) else parts[-1]


def _apply_hunks(original_lines: list[str],
                 hunks: list[tuple[int, list[str]]],
                 forward_only: bool = False) -> list[str]:
    result = list(original_lines)
    offset = 0
    for start_line, hunk_lines in hunks:
        idx = start_line - 1 + offset
        removals = 0
        additions: list[str] = []
        context_lines: list[str] = []
        for hl in hunk_lines:
            if hl.startswith("-"):
                removals += 1
                context_lines.append(hl[1:])
            elif hl.startswith("+"):
                additions.append(hl[1:])
            elif hl.startswith(" "):
                context_lines.append(hl[1:])
        if forward_only and removals > 0:
            expected = context_lines[:removals]
            actual = result[idx:idx + removals]
            if expected != actual:
                continue
        result[idx:idx + removals] = additions
        offset += len(additions) - removals
    return result


def _parse_patch(patch_text: str,
                 strip_count: int) -> dict[str, list[tuple[int, list[str]]]]:
    files: dict[str, list[tuple[int, list[str]]]] = {}
    current_file: str | None = None
    current_hunks: list[tuple[int, list[str]]] = []
    current_hunk_lines: list[str] = []
    current_start = 0

    for line in patch_text.splitlines():
        if line.startswith("--- "):
            continue
        if line.startswith("+++ "):
            if current_file and current_hunk_lines:
                current_hunks.append((current_start, current_hunk_lines))
            if current_file:
                files[current_file] = current_hunks
            raw_path = line[4:].split("\t")[0].strip()
            current_file = "/" + _strip_path(raw_path, strip_count).lstrip("/")
            current_hunks = []
            current_hunk_lines = []
            continue
        m = re.match(r"@@ -(\d+)", line)
        if m:
            if current_hunk_lines:
                current_hunks.append((current_start, current_hunk_lines))
            current_start = int(m.group(1))
            current_hunk_lines = []
            continue
        if current_file and (line.startswith("+") or line.startswith("-")
                             or line.startswith(" ")):
            current_hunk_lines.append(line)

    if current_file and current_hunk_lines:
        current_hunks.append((current_start, current_hunk_lines))
    if current_file:
        files[current_file] = current_hunks

    return files


@command("patch", resource="sharepoint", spec=SPECS["patch"], write=True)
async def patch(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    p: str | None = None,
    R: bool = False,
    i: PathSpec | None = None,
    N: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    strip_count = int(p) if p else 0

    if i is not None:
        i_path = i.strip_prefix
        patch_data = await read_bytes(accessor, i_path)
    elif paths:
        paths = await resolve_glob(accessor, paths, index)
        patch_data = await read_bytes(accessor, paths[0])
    else:
        patch_data = await _read_stdin_async(stdin)
    if not patch_data:
        raise ValueError("patch: missing input")

    patch_text = patch_data.decode(errors="replace")
    file_hunks = _parse_patch(patch_text, strip_count)

    writes: dict[str, bytes] = {}
    for file_path, hunks in file_hunks.items():
        try:
            original = (await read_bytes(accessor,
                                         file_path)).decode(errors="replace")
        except FileNotFoundError:
            original = ""
        original_lines = original.splitlines()

        if R:
            reversed_hunks: list[tuple[int, list[str]]] = []
            for start, hunk_lines in hunks:
                reversed_lines = []
                for hl in hunk_lines:
                    if hl.startswith("+"):
                        reversed_lines.append("-" + hl[1:])
                    elif hl.startswith("-"):
                        reversed_lines.append("+" + hl[1:])
                    else:
                        reversed_lines.append(hl)
                reversed_hunks.append((start, reversed_lines))
            hunks = reversed_hunks

        patched_lines = _apply_hunks(original_lines, hunks, forward_only=N)
        patched_data = ("\n".join(patched_lines) + "\n").encode()
        await write_bytes(accessor, file_path, patched_data)
        writes[file_path] = patched_data

    return None, IOResult(writes=writes)
