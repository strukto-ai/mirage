from collections.abc import AsyncIterator

from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.read import read_stream
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _chain_streams(
        streams: list[CachableAsyncIterator]) -> AsyncIterator[bytes]:
    for stream in streams:
        async for chunk in stream:
            yield chunk


@command("cat", resource="dify", spec=SPECS["cat"])
async def cat(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    n: bool = False,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    index = _extra.get("index")
    paths = await resolve_glob(accessor, paths, index)
    streams: list[CachableAsyncIterator] = []
    reads = {}
    cache = []
    for path in paths:
        stream = CachableAsyncIterator(read_stream(accessor, path, index))
        streams.append(stream)
        reads[path.original] = stream
        cache.append(path.original)
    source: ByteSource = streams[0] if len(streams) == 1 else _chain_streams(
        streams)
    if n:
        return generic_cat(source, number_lines=True), IOResult(reads=reads,
                                                                cache=cache)
    return source, IOResult(reads=reads, cache=cache)
