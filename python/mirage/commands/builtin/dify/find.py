from functools import partial

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.find import find as generic_find
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.dify.find import find as find_core
from mirage.core.dify.glob import resolve_glob
from mirage.core.dify.stat import stat as stat_core
from mirage.core.dify.stat import stat_light
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


def _default_paths(paths: list[PathSpec],
                   cwd: PathSpec | None) -> list[PathSpec]:
    if paths:
        return paths
    if cwd is not None:
        return [cwd]
    return [PathSpec(resource_path="", virtual="/", directory="/")]


def _is_bare_name(texts: tuple[str, ...]) -> bool:
    return bool(texts) and not texts[0].startswith("-") and texts[0] not in (
        "(", ")", "!")


def _default_name(name: str | None, texts: tuple[str, ...]) -> str | None:
    if name is not None:
        return name
    if _is_bare_name(texts):
        return texts[0]
    return None


def _expr_texts(texts: tuple[str, ...]) -> tuple[str, ...]:
    if _is_bare_name(texts):
        return ()
    return texts


async def _normalize_find_output(
    stdout: ByteSource | None,
    search_path: PathSpec,
) -> ByteSource | None:
    if stdout is None:
        return None
    data = stdout if isinstance(stdout, bytes) else b""
    root = mount_prefix_of(search_path.virtual,
                           search_path.resource_path).rstrip("/") or "/"
    lines = data.decode().splitlines()
    normalized = [root if line == root + "/" else line for line in lines]
    return format_records(normalized)


@command("find", resource="dify", spec=SPECS["find"])
async def find(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    name: str | None = None,
    type: str | None = None,
    maxdepth: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
    index: IndexCacheStore | None = None,
    cwd: PathSpec | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = _default_paths(paths, cwd)
    paths = await resolve_glob(accessor, paths, index)
    search_path = paths[0]

    stat_fn = (partial(stat_core, accessor, index=index) if mtime is not None
               else partial(stat_light, accessor, index=index))
    stdout, io = await generic_find(paths,
                                    _expr_texts(texts),
                                    find_core=partial(find_core,
                                                      accessor,
                                                      index=index),
                                    stat=stat_fn,
                                    name=_default_name(name, texts),
                                    type=type,
                                    size=size,
                                    mtime=mtime,
                                    maxdepth=maxdepth,
                                    iname=iname,
                                    path=path,
                                    mindepth=mindepth)
    return await _normalize_find_output(stdout, search_path), io
