import logging
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.archive.types import Walked
from mirage.commands.builtin.generic.archive.walk import DirProbe, WalkFn
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.generic_bind.adapter import CommandIO, OperationFn
from mirage.ops.types import ChildMounts
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec

logger = logging.getLogger(__name__)


async def _walk(readdir: OperationFn, stat: OperationFn,
                index: IndexCacheStore | None, path: PathSpec,
                find_type: str) -> Walked:
    """One subtree listing, filtered to files or to directories.

    Reuses find's walk so an archiver classifies an entry exactly the
    way find does (through stat, never by name). The two calls a
    directory operand makes share one readdir cache, so the second is
    answered from the index instead of the backend. A directory the
    walk could not open rides along, so the archiver can report it the
    way GNU does instead of silently leaving its contents out.

    Args:
        readdir (OperationFn): backend readdir.
        stat (OperationFn): backend stat.
        index (IndexCacheStore | None): the per-call cache index.
        path (PathSpec): the operand to walk.
        find_type (str): "d" or "f".
    """
    unreadable: list[str] = []
    paths = await walk_find(path,
                            readdir=readdir,
                            stat=stat,
                            index=index,
                            args=parse_find_args((), type=find_type),
                            unreadable=unreadable)
    return Walked(paths=tuple(paths), unreadable=tuple(unreadable))


async def _is_dir(stat: OperationFn, readdir: OperationFn, path: PathSpec,
                  index: IndexCacheStore | None) -> bool:
    """Whether a path is a directory an archiver could chdir into.

    Two channels, because a stat miss alone is not absence: on a prefix
    store a directory is the set of keys under it and nothing answers
    stat for it, so a readdir that returns anything is the second and
    deciding opinion.

    Args:
        stat (OperationFn): backend stat.
        readdir (OperationFn): backend readdir.
        path (PathSpec): the candidate directory.
        index (IndexCacheStore | None): the per-call cache index.
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


async def _relayed_stat(dispatch: DispatchFn,
                        path: PathSpec,
                        index: IndexCacheStore | None = None) -> FileStat:
    """Stat one path on the mount that owns it.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
        path (PathSpec): the path to stat.
        index (IndexCacheStore | None): unused; the owning mount keeps
            its own.
    """
    found, _ = await dispatch("stat", path)
    return found


async def _own_listing(dispatch: DispatchFn,
                       owed: ChildMounts | None,
                       path: PathSpec,
                       index: IndexCacheStore | None = None) -> list[str]:
    """One directory as its own backend lists it, through the dispatcher.

    The door adds the names the namespace owes a directory (nested
    mount roots and symlinks) to every listing. The archive scan adds
    those itself, from the same tables, and a walk that followed one
    would descend into a link's target under the link's name or into a
    mount the scan must not cross, so they are left to the scan.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
        owed (ChildMounts | None): the names the namespace owes a
            directory; None lists everything the door does.
        path (PathSpec): the directory to list.
        index (IndexCacheStore | None): unused; the owning mount keeps
            its own.
    """
    entries, _ = await dispatch("readdir", path)
    if owed is None:
        return list(entries)
    names = set(owed(path.virtual))
    return [
        entry for entry in entries
        if entry.rstrip("/").rsplit("/", 1)[-1] not in names
    ]


def relay_walk_of(dispatch: DispatchFn, owed: ChildMounts | None) -> WalkFn:
    """The subtree listing tar and zip walk with when a line spans mounts.

    Every directory is listed on the mount that owns it, so operands
    from several mounts go into one archive, and find's walk classifies
    what it lists exactly as it does on one backend.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
        owed (ChildMounts | None): the names the namespace owes a
            directory, which the scan merges itself.
    """
    return partial(_walk, partial(_own_listing, dispatch, owed),
                   partial(_relayed_stat, dispatch), None)


def relay_is_dir_of(dispatch: DispatchFn) -> DirProbe:
    """The directory probe tar's ``-C`` check uses when a line spans mounts.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
    """
    return partial(_is_dir,
                   partial(_relayed_stat, dispatch),
                   partial(_own_listing, dispatch, None),
                   index=None)
