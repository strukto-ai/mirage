from mirage.core.dify.grep import grep_bytes
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("grep", resource="dify")
async def grep(accessor, paths: list[PathSpec], pattern: str, *, index,
               **kwargs) -> bytes:
    return await grep_bytes(accessor, paths, pattern, index)
