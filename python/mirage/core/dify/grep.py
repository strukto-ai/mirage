import asyncio
import re
from collections.abc import AsyncIterator

from mirage.accessor.dify import DifyAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dify.read import read_stream
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.types import PathSpec


async def grep_bytes(accessor: DifyAccessor,
                     paths: list[PathSpec],
                     pattern: str,
                     index: IndexCacheStore = NULL_INDEX,
                     ignore_case: bool = False) -> bytes:
    flags = re.IGNORECASE if ignore_case else 0
    regex = re.compile(pattern, flags)
    lines: list[str] = []
    if not paths:
        return b""
    queue: asyncio.Queue[tuple[int, PathSpec] | None] = asyncio.Queue()
    results: list[list[str] | None] = [None] * len(paths)
    for position, path in enumerate(paths):
        queue.put_nowait((position, path))
    worker_count = min(accessor.config.max_concurrency, len(paths))
    for _ in range(worker_count):
        queue.put_nowait(None)
    async with asyncio.TaskGroup() as group:
        for _ in range(worker_count):
            group.create_task(
                _grep_worker(accessor, regex, index, queue, results))
    for result in results:
        if result is None:
            raise RuntimeError("Dify grep worker did not return a result")
        lines.extend(result)
    return "\n".join(lines).encode()


async def _grep_worker(
    accessor: DifyAccessor,
    regex: re.Pattern[str],
    index: IndexCacheStore,
    queue: asyncio.Queue[tuple[int, PathSpec] | None],
    results: list[list[str] | None],
) -> None:
    while True:
        item = await queue.get()
        try:
            if item is None:
                return
            position, path = item
            results[position] = await _grep_path(accessor, path, regex, index)
        finally:
            queue.task_done()


async def _grep_path(accessor: DifyAccessor, path: PathSpec,
                     regex: re.Pattern[str],
                     index: IndexCacheStore) -> list[str]:
    lines: list[str] = []
    async for line_number, raw_line in _enumerate_lines(
            read_stream(accessor, path, index)):
        line = raw_line.decode(errors="replace")
        if regex.search(line):
            lines.append(f"{path.virtual}:{line_number}:{line}")
    return lines


async def _enumerate_lines(
        source: AsyncIterator[bytes]) -> AsyncIterator[tuple[int, bytes]]:
    line_number = 0
    async for raw_line in AsyncLineIterator(source):
        line_number += 1
        yield line_number, raw_line
