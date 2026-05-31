from mirage.core.dify import search as search_core
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("search", resource="dify")
async def search(accessor, paths: list[PathSpec], query: str, *, index,
                 **kwargs) -> bytes:
    return await search_core.search_segments(accessor, query, paths, index,
                                             **kwargs)
