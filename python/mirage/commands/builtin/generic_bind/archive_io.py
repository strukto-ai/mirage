import logging
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.archive.walk import DirProbe, WalkFn
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.generic_bind.adapter import CommandIO, OperationFn
from mirage.types import FileType, PathSpec

logger = logging.getLogger(__name__)


async def _walk(readdir: OperationFn, stat: OperationFn,
                index: IndexCacheStore, path: PathSpec,
                find_type: str) -> list[str]:
    """One subtree listing, filtered to files or to directories.

    Reuses find's walk so an archiver classifies an entry exactly the
    way find does (through stat, never by name). The two calls a
    directory operand makes share one readdir cache, so the second is
    answered from the index instead of the backend.

    Args:
        readdir (OperationFn): backend readdir.
        stat (OperationFn): backend stat.
        index (IndexCacheStore): the per-call cache index.
        path (PathSpec): the operand to walk.
        find_type (str): "d" or "f".
    """
    return await walk_find(path,
                           readdir=readdir,
                           stat=stat,
                           index=index,
                           args=parse_find_args((), type=find_type))


async def _is_dir(stat: OperationFn, readdir: OperationFn, path: PathSpec,
                  index: IndexCacheStore) -> bool:
    """Whether a path is a directory an archiver could chdir into.

    Two channels, because a stat miss alone is not absence: on a prefix
    store a directory is the set of keys under it and nothing answers
    stat for it, so a readdir that returns anything is the second and
    deciding opinion.

    Args:
        stat (OperationFn): backend stat.
        readdir (OperationFn): backend readdir.
        path (PathSpec): the candidate directory.
        index (IndexCacheStore): the per-call cache index.
    """
    try:
        return (await stat(path, index)).type == FileType.DIRECTORY
    except (FileNotFoundError, ValueError):
        logger.debug("archive: %s does not stat; asking readdir", path.virtual)
    try:
        return bool(await readdir(path, index))
    except (FileNotFoundError, ValueError) as exc:
        logger.debug("archive: %s is not a directory on either channel: %r",
                     path.virtual, exc)
        return False


def walk_of(ops: CommandIO, accessor: Accessor,
            index: IndexCacheStore) -> WalkFn:
    """The subtree listing tar and zip both walk with.

    Args:
        ops (CommandIO): the bound backend operations.
        accessor (Accessor): the mount's accessor.
        index (IndexCacheStore): the per-call cache index.
    """
    return partial(_walk, partial(ops.readdir, accessor),
                   partial(ops.stat, accessor), index)


def is_dir_of(ops: CommandIO, accessor: Accessor,
              index: IndexCacheStore) -> DirProbe:
    """The directory probe tar's ``-C`` check uses.

    Args:
        ops (CommandIO): the bound backend operations.
        accessor (Accessor): the mount's accessor.
        index (IndexCacheStore): the per-call cache index.
    """
    return partial(_is_dir,
                   partial(ops.stat, accessor),
                   partial(ops.readdir, accessor),
                   index=index)
