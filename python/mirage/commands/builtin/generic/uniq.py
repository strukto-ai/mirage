from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _comparison_key(
    line: bytes,
    skip_fields: int,
    skip_chars: int,
    check_chars: int,
    ignore_case: bool,
) -> bytes:
    text = line
    if skip_fields > 0:
        decoded = text.decode(errors="replace")
        parts = decoded.split()
        remaining = parts[skip_fields:] if skip_fields < len(parts) else []
        text = " ".join(remaining).encode()
    if skip_chars > 0:
        text = text[skip_chars:]
    if check_chars > 0:
        text = text[:check_chars]
    if ignore_case:
        text = text.lower()
    return text


def _should_emit(prev_count: int, duplicates_only: bool,
                 unique_only: bool) -> bool:
    if duplicates_only and prev_count == 1:
        return False
    if unique_only and prev_count > 1:
        return False
    return True


async def _uniq_stream(
    source: AsyncIterator[bytes],
    count: bool,
    duplicates_only: bool,
    unique_only: bool,
    skip_fields: int,
    skip_chars: int,
    ignore_case: bool,
    check_chars: int,
) -> AsyncIterator[bytes]:
    prev_line: bytes | None = None
    prev_key: bytes | None = None
    prev_count = 0
    async for raw_line in AsyncLineIterator(source):
        key = _comparison_key(raw_line, skip_fields, skip_chars, check_chars,
                              ignore_case)
        if key == prev_key:
            prev_count += 1
        else:
            if prev_line is not None and _should_emit(
                    prev_count, duplicates_only, unique_only):
                if count:
                    yield f"{prev_count:>7} ".encode() + prev_line + b"\n"
                else:
                    yield prev_line + b"\n"
            prev_line = raw_line
            prev_key = key
            prev_count = 1
    if prev_line is not None and _should_emit(prev_count, duplicates_only,
                                              unique_only):
        if count:
            yield f"{prev_count:>7} ".encode() + prev_line + b"\n"
        else:
            yield prev_line + b"\n"


async def uniq(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    count: bool = False,
    duplicates_only: bool = False,
    unique_only: bool = False,
    skip_fields: int = 0,
    skip_chars: int = 0,
    ignore_case: bool = False,
    check_chars: int = 0,
) -> tuple[ByteSource | None, IOResult]:
    cache: list[str] = []
    if paths:
        source = read_stream(accessor, paths[0])
        cache = [paths[0].strip_prefix]
    else:
        source = _resolve_source(stdin, "uniq: missing operand")

    return _uniq_stream(
        source,
        count=count,
        duplicates_only=duplicates_only,
        unique_only=unique_only,
        skip_fields=skip_fields,
        skip_chars=skip_chars,
        ignore_case=ignore_case,
        check_chars=check_chars,
    ), IOResult(cache=cache)


__all__ = ["uniq"]
