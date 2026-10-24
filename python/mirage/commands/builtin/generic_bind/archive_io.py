import logging
from functools import partial
from typing import cast

from mirage.commands.builtin.generic.archive.types import Walked
from mirage.commands.builtin.generic.archive.walk import DirProbe, WalkFn
from mirage.commands.builtin.generic.find import parse_find_args
from mirage.commands.builtin.generic_bind.files import (
    CommandFiles,
    dispatched_call,
)
from mirage.commands.builtin.utils.tree import (
    ReadTree,
    WalkCall,
    before_full_walk,
    tree_walk,
)
from mirage.core.generic.find import walk_find
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec, ReaddirFn, StatFn
from mirage.view.types import ChildMounts

logger = logging.getLogger(__name__)


async def _walk_with(
    readdir: ReaddirFn,
    stat: StatFn,
    dispatch: DispatchFn | None,
    command: str,
    path: PathSpec,
    find_type: str,
) -> Walked:
    """One subtree listing, filtered to files or to directories.

    Reuses find's walk so an archiver classifies an entry exactly the
    way find does (through stat, never by name). The two calls a
    directory operand makes share one readdir cache, so the second is
    answered from the index instead of the backend. A directory the
    walk could not open rides along, so the archiver can report it the
    way GNU does instead of silently leaving its contents out. The
    files listed are every file the archiver reads, so the mount that
    owns ``path`` may refuse the walk before they are listed.

    Args:
        readdir (ReaddirFn): the walk's readdir.
        stat (StatFn): the walk's stat.
        dispatch (DispatchFn | None): the command's dispatcher, which
            asks the mount's ``before_full_walk``.
        command (str): tar or zip.
        path (PathSpec): the operand to walk.
        find_type (str): "d" or "f".
    """
    if find_type == "f":
        await before_full_walk(dispatch, path, command)
    unreadable: list[str] = []
    paths = await walk_find(
        path,
        readdir=readdir,
        stat=stat,
        args=parse_find_args((), type=find_type),
        unreadable=unreadable,
    )
    return Walked(paths=tuple(paths), unreadable=tuple(unreadable))


async def _is_dir_with(
    stat: StatFn, readdir: ReaddirFn, path: PathSpec
) -> bool:
    """Whether a path is a directory an archiver could chdir into.

    Two channels, because a stat miss alone is not absence: on a prefix
    store a directory is the set of keys under it and nothing answers
    stat for it, so a readdir that returns anything is the second and
    deciding opinion.

    Args:
        stat (StatFn): the probe's stat.
        readdir (ReaddirFn): the probe's readdir.
        path (PathSpec): the candidate directory.
    """
    try:
        return (await stat(path)).type == FileType.DIRECTORY
    except (FileNotFoundError, NotADirectoryError, ValueError):
        logger.debug("archive: %s does not stat; asking readdir", path.virtual)
    try:
        return bool(await readdir(path))
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        logger.debug(
            "archive: %s is not a directory on either channel: %r",
            path.virtual,
            exc,
        )
        return False


def walk_of(
    files: CommandFiles, dispatch: DispatchFn | None, command: str
) -> WalkFn:
    """The subtree listing tar and zip both walk with.

    Args:
        files (CommandFiles): the command's files.
        dispatch (DispatchFn | None): the command's dispatcher, which
            asks the mount's ``before_full_walk``.
        command (str): tar or zip.
    """
    readdir, stat = tree_walk(
        files.read_tree if files.answers("read_tree") else None,
        files.readdir,
        files.stat,
    )
    return partial(_walk_with, readdir, stat, dispatch, command)


def is_dir_of(files: CommandFiles) -> DirProbe:
    """The directory probe tar's ``-C`` check uses.

    Args:
        files (CommandFiles): the command's files.
    """
    return partial(_is_dir_with, files.stat, files.readdir)


async def _relayed_stat(dispatch: DispatchFn, path: PathSpec) -> FileStat:
    """Stat one path on the mount that owns it.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
        path (PathSpec): the path to stat.
    """
    found, _ = await dispatch("stat", path)
    return cast(FileStat, found)


async def _own_listing(
    readdir: WalkCall, owed: ChildMounts | None, path: PathSpec
) -> list[str]:
    """One directory as its own backend lists it, through the dispatcher.

    The dispatcher adds the names the namespace owes a directory (nested
    mount roots and symlinks) to every listing. The archive scan adds
    those itself, from the same tables, and a walk that followed one
    would descend into a link's target under the link's name or into a
    mount the scan must not cross, so they are left to the scan.

    Args:
        readdir (WalkCall): the relay's listing.
        owed (ChildMounts | None): the names the namespace owes a
            directory; None lists everything the dispatcher does.
        path (PathSpec): the directory to list.
    """
    entries = await readdir(path)
    if owed is None:
        return list(entries)
    names = set(owed(path.virtual))
    return [
        entry
        for entry in entries
        if entry.rstrip("/").rsplit("/", 1)[-1] not in names
    ]


def relay_walk_of(
    dispatch: DispatchFn,
    owed: ChildMounts | None,
    command: str,
    read_tree: ReadTree | None = None,
) -> WalkFn:
    """The subtree listing tar and zip walk with when a line spans mounts.

    Every directory is listed on the mount that owns it, so operands
    from several mounts go into one archive, and find's walk classifies
    what it lists exactly as it does on one backend.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
        owed (ChildMounts | None): the names the namespace owes a
            directory, which the scan merges itself.
        command (str): tar or zip.
        read_tree (ReadTree | None): the walk's subtree read
            (``dispatched_read_tree``); None lists every directory.
    """
    readdir, stat = tree_walk(
        read_tree,
        partial(dispatched_call, dispatch, "readdir"),
        partial(_relayed_stat, dispatch),
    )
    return partial(
        _walk_with,
        partial(_own_listing, readdir, owed),
        stat,
        dispatch,
        command,
    )


def relay_is_dir_of(dispatch: DispatchFn) -> DirProbe:
    """The directory probe tar's ``-C`` check uses when a line spans mounts.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
    """
    return partial(
        _is_dir_with,
        partial(_relayed_stat, dispatch),
        partial(dispatched_call, dispatch, "readdir"),
    )
