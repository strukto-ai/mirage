import re

from mirage.cache.index import IndexCacheStore
from mirage.core.dify.read import read_stream
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.types import PathSpec


async def grep_bytes(
        accessor,
        paths: list[PathSpec],
        pattern: str,
        index: IndexCacheStore,
        ignore_case: bool = False) -> tuple[bytes, dict[str, bytes]]:
    flags = re.IGNORECASE if ignore_case else 0
    regex = re.compile(pattern, flags)
    lines: list[str] = []
    reads: dict[str, bytes] = {}
    for path in paths:
        chunks: list[bytes] = []
        stream = _record_chunks(read_stream(accessor, path, index), chunks)
        async for line_number, raw_line in _enumerate_lines(stream):
            line = raw_line.decode(errors="replace")
            if regex.search(line):
                lines.append(f"{path.virtual}:{line_number}:{line}")
        reads[path.virtual] = b"".join(chunks)
    return "\n".join(lines).encode(), reads


async def _record_chunks(source, chunks: list[bytes]):
    async for chunk in source:
        chunks.append(chunk)
        yield chunk


async def _enumerate_lines(source):
    line_number = 0
    async for raw_line in AsyncLineIterator(source):
        line_number += 1
        yield line_number, raw_line
