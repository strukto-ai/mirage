from dataclasses import dataclass

from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.chroma.tree import ensure_tree
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


@dataclass(frozen=True)
class ResolvedChromaPath:
    virtual_key: str
    mount_prefix: str
    is_dir: bool
    entry: IndexEntry | None = None


async def resolve_path(accessor, path: PathSpec,
                       index: IndexCacheStore) -> ResolvedChromaPath:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    mount_prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    await ensure_tree(accessor, index, mount_prefix)
    virtual_key = virtual_key_for(path)
    result = await index.get(virtual_key)
    if result.entry is not None:
        return ResolvedChromaPath(
            virtual_key=virtual_key,
            mount_prefix=mount_prefix,
            is_dir=result.entry.resource_type == "folder",
            entry=result.entry,
        )
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return ResolvedChromaPath(virtual_key=virtual_key,
                                  mount_prefix=mount_prefix,
                                  is_dir=True)
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
