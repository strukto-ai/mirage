from mirage.core.dify.readdir import readdir as core_readdir
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("readdir", resource="dify")
async def readdir(accessor, path: PathSpec, *, index, **kwargs) -> list[str]:
    return await core_readdir(accessor, path, index)
