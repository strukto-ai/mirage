from dataclasses import dataclass
from typing import Literal, TypeAlias

from mirage.accessor.dify import DifyAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.dify.tree import ensure_tree
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


@dataclass(frozen=True)
class ResolvedDifyDirectory:
    virtual_key: str
    mount_prefix: str
    is_dir: Literal[True] = True


@dataclass(frozen=True)
class ResolvedDifyFile:
    virtual_key: str
    mount_prefix: str
    entry: IndexEntry
    is_dir: Literal[False] = False


ResolvedDifyPath: TypeAlias = ResolvedDifyDirectory | ResolvedDifyFile


async def resolve_path(
        accessor: DifyAccessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX) -> ResolvedDifyPath:
    mount_prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    await ensure_tree(accessor, index, mount_prefix)
    virtual_key = virtual_key_for(path)
    result = await index.get(virtual_key)
    if result.entry is not None:
        if result.entry.resource_type == "folder":
            return ResolvedDifyDirectory(virtual_key=virtual_key,
                                         mount_prefix=mount_prefix)
        return ResolvedDifyFile(
            virtual_key=virtual_key,
            mount_prefix=mount_prefix,
            entry=result.entry,
        )
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return ResolvedDifyDirectory(virtual_key=virtual_key,
                                     mount_prefix=mount_prefix)
    raise enoent(path)


def virtual_key_for(path: PathSpec) -> str:
    raw = path.directory if path.pattern else path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    if prefix:
        root = prefix.rstrip("/") or "/"
        if raw == root or raw.startswith(root + "/"):
            return raw.rstrip("/") or root
        rest = raw.strip("/")
        if not rest:
            return root
        return root + "/" + rest
    stripped = raw.strip("/")
    return "/" + stripped if stripped else "/"
