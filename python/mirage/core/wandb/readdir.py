from collections.abc import Mapping, Sequence
from typing import Any

from mirage.accessor.wandb import WandbAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.wandb.errors import WandbAPIError
from mirage.core.wandb.pathing import LEAVES, parts, run_vars, safe_name
from mirage.core.wandb.queries import RUN_EXISTS
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir
from mirage.utils.key_prefix import mount_prefix_of


def entry(name: str, directory: bool, size: int | None = None) -> IndexEntry:
    return IndexEntry(
        id=name,
        name=name,
        vfs_name=name,
        resource_type="wandb/directory" if directory else "wandb/file",
        size=0 if directory else size)


def file_tree(
    files: Sequence[Mapping[str,
                            Any]]) -> dict[str, list[tuple[str, IndexEntry]]]:
    directories: dict[str, dict[str, IndexEntry]] = {"": {}}
    for file in files:
        segments = file["name"].split("/")
        if not all(safe_name(p) for p in segments):
            raise WandbAPIError("W&B unsafe run file name")
        parent = ""
        for depth, child in enumerate(segments):
            directory = depth < len(segments) - 1
            node = entry(child, directory, file.get("sizeBytes"))
            children = directories.setdefault(parent, {})
            previous = children.get(child)
            if previous and previous.resource_type != node.resource_type:
                raise WandbAPIError("W&B file and directory name collision")
            children[child] = node
            parent = parent + "/" + child if parent else child
    return {
        parent: list(children.items())
        for parent, children in directories.items()
    }


def file_entries(files: Sequence[Mapping[str, Any]],
                 prefix: str) -> list[tuple[str, IndexEntry]]:
    return file_tree(files).get(prefix.rstrip("/"), [])


async def listing(
        accessor: WandbAccessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX) -> list[tuple[str, IndexEntry]]:
    ps = parts(accessor, path)
    if not ps:
        return [(e, entry(e, True))
                for e in dict.fromkeys(accessor.config.entities)]
    if len(ps) == 1:
        nodes = await accessor.client.projects(ps[0])
    elif len(ps) == 2:
        nodes = await accessor.client.runs(*ps)
    elif len(ps) == 3:
        key = path.virtual.rstrip("/")
        parent = key.rsplit("/", 1)[0] or "/"
        cached = await index.list_dir(parent) if index is not None else None
        if (cached is None or cached.entries is None
                or key not in cached.entries):
            await accessor.client.run(run_vars(ps), RUN_EXISTS)
        return [(n, entry(n, False))
                for n in LEAVES] + [("files", entry("files", True))]
    elif ps[3] == "files":
        files = await accessor.client.files(run_vars(ps))
        prefix = "/".join(ps[4:])
        if prefix and any(f["name"] == prefix for f in files):
            raise enotdir(path)
        tree = file_tree(files)
        if prefix not in tree:
            raise enoent(path)
        if index is not None:
            root = mount_prefix_of(path.virtual,
                                   path.vfs_path) + "/" + "/".join(ps[:4])
            await index.invalidate_prefix(root)
            await index.put(root, entry("files", True))
            for directory, entries in tree.items():
                await index.set_dir(
                    root + "/" + directory if directory else root, entries)
        return tree[prefix]
    elif ps[3] in LEAVES:
        raise enotdir(path)
    else:
        raise enoent(path)
    result = []
    for node in nodes:
        name = node["name"]
        if not safe_name(name):
            raise WandbAPIError("W&B unsafe object name")
        result.append((name, entry(name, True)))
    return result


async def readdir(accessor: WandbAccessor,
                  path_spec: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    path = path_spec.dir if path_spec.pattern else path_spec
    parts(accessor, path)
    key = path.virtual.rstrip("/") or "/"
    if index is not None:
        cached = await index.list_dir(key)
        if cached.entries is not None:
            return cached.entries
    entries = await listing(accessor, path, index)
    if index is not None:
        await index.set_dir(key, entries)
    return [key.rstrip("/") + "/" + name for name, _ in entries]
