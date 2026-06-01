from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.tree import tree as generic_tree
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.readdir import readdir
from mirage.core.dify.stat import stat_light
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def default_paths(paths: list[PathSpec],
                  cwd: PathSpec | None) -> list[PathSpec]:
    if paths:
        return paths
    if cwd is not None:
        return [cwd]
    return [PathSpec(original="/", directory="/")]


@command("tree", resource="dify", spec=SPECS["tree"])
async def tree(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    L: str | None = None,
    a: bool = False,
    args_I: str | None = None,
    d: bool = False,
    P: str | None = None,
    index: IndexCacheStore = None,
    cwd: PathSpec | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = default_paths(paths, cwd)
    paths = await resolve_glob(accessor, paths, index)
    return await generic_tree(
        paths[0],
        readdir=partial(readdir, accessor),
        stat=partial(stat_light, accessor),
        max_depth=int(L) if L is not None else None,
        show_hidden=a,
        ignore_pattern=args_I,
        dirs_only=d,
        match_pattern=P,
        index=index,
    )
