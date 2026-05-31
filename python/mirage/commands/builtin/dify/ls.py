from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.ls import ls as generic_ls
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.readdir import readdir
from mirage.core.dify.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import LsSortBy, PathSpec


def _default_paths(paths: list[PathSpec],
                   cwd: PathSpec | None) -> list[PathSpec]:
    if paths:
        return paths
    if cwd is not None:
        return [cwd]
    return [PathSpec(original="/", directory="/")]


async def _readdir(accessor, path: PathSpec,
                   index: IndexCacheStore | None) -> list[str]:
    if index is None:
        raise ValueError("ls: missing index")
    return await readdir(accessor, path, index)


@command("ls", resource="dify", spec=SPECS["ls"])
async def ls(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    args_l: bool = False,
    args_1: bool = False,
    a: bool = False,
    A: bool = False,
    h: bool = False,
    t: bool = False,
    S: bool = False,
    r: bool = False,
    R: bool = False,
    d: bool = False,
    F: bool = False,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    index = _extra.get("index")
    cwd = _extra.get("cwd")
    paths = _default_paths(paths, cwd if isinstance(cwd, PathSpec) else None)
    paths = await resolve_glob(accessor, paths, index)
    sort_by = LsSortBy.TIME if t else LsSortBy.SIZE if S else LsSortBy.NAME
    return await generic_ls(
        paths,
        readdir=partial(_readdir, accessor),
        stat=partial(stat, accessor),
        long=args_l,
        one_per_line=args_1,
        all_files=a or A,
        human=h,
        sort_by=sort_by,
        reverse=r,
        recursive=R,
        list_dir=d,
        classify=F,
        index=index,
    )
