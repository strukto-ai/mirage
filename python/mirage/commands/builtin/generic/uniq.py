import re
from collections.abc import AsyncIterator, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _parse_count(value: str | None) -> int | None:
    if value is None:
        return None
    normalized = value.strip()
    if re.fullmatch(r"[+-]?[0-9]+", normalized) is None:
        raise ValueError(f"uniq: invalid count: '{value}'")
    count = int(normalized)
    if count < 0:
        raise ValueError(f"uniq: invalid count: '{value}'")
    return count


def _comparison_key(
    line: bytes,
    skip_fields: int,
    skip_chars: int,
    check_chars: int | None,
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
    if check_chars is not None:
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
    check_chars: int | None,
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
    stdin: ByteSource | None = None,
    count: bool = False,
    duplicates_only: bool = False,
    unique_only: bool = False,
    skip_fields: str | None = None,
    skip_chars: str | None = None,
    ignore_case: bool = False,
    check_chars: str | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(CommandName.UNIQ, paths[2].raw_path
                                  or paths[2].virtual)
    cache: list[str] = []
    if paths:
        source: AsyncIterator[bytes] = read_stream(paths[0])
        cache = [paths[0].mount_path]
    else:
        source = _resolve_source(stdin)

    return _uniq_stream(
        source,
        count=count,
        duplicates_only=duplicates_only,
        unique_only=unique_only,
        skip_fields=_parse_count(skip_fields) or 0,
        skip_chars=_parse_count(skip_chars) or 0,
        ignore_case=ignore_case,
        check_chars=_parse_count(check_chars),
    ), IOResult(cache=cache)


__all__ = ["uniq"]
