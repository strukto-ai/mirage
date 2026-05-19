import re
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _strip_path(path: str, strip_count: int) -> str:
    parts = path.split("/")
    return "/".join(
        parts[strip_count:]) if strip_count < len(parts) else parts[-1]


def _apply_hunks(original_lines: list[str],
                 hunks: list[tuple[int, list[str]]],
                 forward_only: bool = False) -> list[str]:
    result: list[str] = []
    src_idx = 0
    for start_line, hunk_lines in hunks:
        hunk_start = start_line - 1
        while src_idx < hunk_start and src_idx < len(original_lines):
            result.append(original_lines[src_idx])
            src_idx += 1
        if forward_only:
            expected = [
                hl[1:] for hl in hunk_lines
                if hl.startswith(" ") or hl.startswith("-")
            ]
            actual = original_lines[src_idx:src_idx + len(expected)]
            if expected != actual:
                for _ in expected:
                    if src_idx < len(original_lines):
                        result.append(original_lines[src_idx])
                        src_idx += 1
                continue
        for hl in hunk_lines:
            if hl.startswith(" "):
                result.append(hl[1:])
                src_idx += 1
            elif hl.startswith("-"):
                src_idx += 1
            elif hl.startswith("+"):
                result.append(hl[1:])
    while src_idx < len(original_lines):
        result.append(original_lines[src_idx])
        src_idx += 1
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


def _reverse_hunks(
        hunks: list[tuple[int, list[str]]]) -> list[tuple[int, list[str]]]:
    out: list[tuple[int, list[str]]] = []
    for start, hunk_lines in hunks:
        reversed_lines: list[str] = []
        for hl in hunk_lines:
            if hl.startswith("+"):
                reversed_lines.append("-" + hl[1:])
            elif hl.startswith("-"):
                reversed_lines.append("+" + hl[1:])
            else:
                reversed_lines.append(hl)
        out.append((start, reversed_lines))
    return out


async def _load_patch_data(
    i: PathSpec | None,
    paths: list[PathSpec],
    has_resource: bool,
    stdin: AsyncIterator[bytes] | bytes | None,
    read_bytes: Callable[..., Awaitable[bytes]],
    accessor: object,
) -> bytes:
    if i is not None and has_resource:
        return await read_bytes(accessor, i.strip_prefix)
    if paths and has_resource:
        return await read_bytes(accessor, paths[0])
    data = await _read_stdin_async(stdin)
    if not data:
        raise ValueError("patch: missing input")
    return data


async def patch(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    has_resource: bool,
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    p: str | None = None,
    R: bool = False,
    i: PathSpec | None = None,
    N: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    strip_count = int(p) if p else 0
    patch_data = await _load_patch_data(i, paths, has_resource, stdin,
                                        read_bytes, accessor)
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
            hunks = _reverse_hunks(hunks)
        patched_lines = _apply_hunks(original_lines, hunks, forward_only=N)
        patched_data = ("\n".join(patched_lines) + "\n").encode()
        await write_bytes(accessor, file_path, patched_data)
        writes[file_path] = patched_data
    return None, IOResult(writes=writes)


__all__ = ["patch"]
