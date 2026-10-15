from collections.abc import Mapping, Sequence
from typing import Any

from mirage.accessor.wandb import WandbAccessor
from mirage.core.wandb.errors import WandbAPIError
from mirage.core.wandb.pathing import LEAVES, parts, run_vars, safe_name
from mirage.core.wandb.queries import RUN_EXISTS
from mirage.errors.fs import enoent, enotdir
from mirage.types import ContentType, DirListing, FileStat, FileType, PathSpec


def row(
    name: str,
    directory: bool,
    size: int | None = None,
    content: ContentType | None = None,
) -> FileStat:
    if directory:
        return FileStat(name=name, type=FileType.DIRECTORY, size=0)
    return FileStat(name=name, type=FileType.FILE, size=size, content=content)


def _leaf(name: str) -> FileStat:
    content = ContentType.JSON if name.endswith(".json") else ContentType.TEXT
    return row(name, False, content=content)


def file_tree(
    files: Sequence[Mapping[str, Any]],
) -> dict[str, list[FileStat]]:
    directories: dict[str, dict[str, FileStat]] = {"": {}}
    for file in files:
        segments = file["name"].split("/")
        if not all(safe_name(p) for p in segments):
            raise WandbAPIError("W&B unsafe run file name")
        parent = ""
        for depth, child in enumerate(segments):
            directory = depth < len(segments) - 1
            node = row(
                child, directory, file.get("sizeBytes"), ContentType.BINARY
            )
            children = directories.setdefault(parent, {})
            previous = children.get(child)
            if previous and previous.type != node.type:
                raise WandbAPIError("W&B file and directory name collision")
            children[child] = node
            parent = parent + "/" + child if parent else child
    return {
        parent: list(children.values())
        for parent, children in directories.items()
    }


def _run_files(
    path: PathSpec, prefix: str, files: Sequence[Mapping[str, Any]]
) -> DirListing:
    """A run's ``files/`` directory, or one below it, from the one call
    that lists every file of the run: each directory below the listed
    one is proven by the same call, so it rides along as a seed.

    Args:
        path (PathSpec): the listed directory.
        prefix (str): its path below ``files/``, empty for ``files/``.
        files (Sequence[Mapping[str, Any]]): the run's files.
    """
    if prefix and any(f["name"] == prefix for f in files):
        raise enotdir(path)
    tree = file_tree(files)
    if prefix not in tree:
        raise enoent(path)
    stem = prefix + "/" if prefix else ""
    return DirListing(
        entries=tree[prefix],
        seeds={
            directory[len(stem) :]: rows
            for directory, rows in tree.items()
            if directory.startswith(stem) and directory != prefix
        },
    )


async def readdir(
    accessor: WandbAccessor, path_spec: PathSpec
) -> list[FileStat] | DirListing:
    """A directory's rows.

    Args:
        accessor (WandbAccessor): the mount's accessor.
        path_spec (PathSpec): the directory, or a glob word in it.
    """
    path = path_spec.dir if path_spec.pattern else path_spec
    ps = parts(accessor, path)
    if not ps:
        return [row(e, True) for e in dict.fromkeys(accessor.config.entities)]
    if len(ps) == 1:
        nodes = await accessor.client.projects(ps[0])
    elif len(ps) == 2:
        nodes = await accessor.client.runs(*ps)
    elif len(ps) == 3:
        await accessor.client.run(run_vars(ps), RUN_EXISTS)
        return [_leaf(n) for n in LEAVES] + [row("files", True)]
    elif ps[3] == "files":
        files = await accessor.client.files(run_vars(ps))
        return _run_files(path, "/".join(ps[4:]), files)
    elif ps[3] in LEAVES:
        raise enotdir(path)
    else:
        raise enoent(path)
    result = []
    for node in nodes:
        name = node["name"]
        if not safe_name(name):
            raise WandbAPIError("W&B unsafe object name")
        result.append(row(name, True))
    return result
