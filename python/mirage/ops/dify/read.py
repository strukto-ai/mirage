from mirage.core.dify.read import read_bytes
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("read", resource="dify")
async def read(accessor, path: PathSpec, *, index, **kwargs) -> bytes:
    return await read_bytes(accessor, path, index)
