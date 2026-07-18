from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.chroma.ops import RESOLVE_GLOB as resolve_glob
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.chroma import search as search_core
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def is_mount_root(path: PathSpec) -> bool:
    root = mount_prefix_of(path.virtual, path.resource_path).rstrip("/") or "/"
    value = path.virtual.rstrip("/") or "/"
    return value == "/" or value == root


@command("chroma-query", resource="chroma", spec=SPECS["search"])
async def search(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    top_k: str | int = 10,
    index: IndexCacheStore,
    cwd: PathSpec | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("search: query is required")
    query = texts[0]
    target_paths = default_paths(paths, cwd)
    mount_prefix = mount_prefix_of(
        target_paths[0].virtual,
        target_paths[0].resource_path) if target_paths else ""
    if any(is_mount_root(path) for path in target_paths):
        resolved_paths: list[PathSpec] = []
    else:
        resolved_paths = await resolve_glob(accessor, target_paths, index)
    output = await search_core.search_segments(accessor,
                                               query,
                                               resolved_paths,
                                               index,
                                               top_k=int(top_k),
                                               mount_prefix=mount_prefix)
    return output, IOResult()
