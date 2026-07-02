from mirage.core.chroma import search as search_core
from mirage.ops.registry import op
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


@op("search", resource="chroma")
async def search(accessor, paths: list[PathSpec], query: str, *, index,
                 **kwargs) -> bytes:
    explicit_prefix = kwargs.pop("mount_prefix", "")
    mount_prefix = mount_prefix_of(
        paths[0].virtual, paths[0].resource_path) if paths else explicit_prefix
    return await search_core.search_segments(accessor,
                                             query,
                                             paths,
                                             index,
                                             mount_prefix=mount_prefix,
                                             **kwargs)
