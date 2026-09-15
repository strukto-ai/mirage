# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import logging
import posixpath

from mirage.commands.cli.builtin.git.constants import PERMISSION_BITS, SYMLINK
from mirage.commands.cli.builtin.git.errors import MountInWayError
from mirage.ops.types import LinkView, MountView, StatPath
from mirage.runtime.types import DispatchFn
from mirage.types import LINK_TARGET_KEY, FileStat, FileType, PathSpec
from mirage.utils.errors import MISS_ERRORS

logger = logging.getLogger(__name__)


async def read_file(dispatch: DispatchFn, path: str) -> bytes:
    """Read one virtual path through the workspace dispatcher.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    data, _ = await dispatch("read", PathSpec.from_str_path(path))
    return data if isinstance(data, bytes) else bytes(data)


async def entry_bytes(dispatch: DispatchFn, path: str,
                      info: FileStat) -> bytes:
    """The bytes git stores for one working-tree entry.

    A symlink's blob is its target string, not what the target holds, so
    reading through the link would stage a second copy of the target
    under mode 100644 and then report the entry modified forever after
    (the staged blob and the bytes behind the link never match). The
    target is namespace state, which is why it arrives on the stat
    rather than from a read.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
        info (FileStat): what the walk saw at that path, lstat-style.
    """
    if info.type is FileType.SYMLINK:
        target = info.extra.get(LINK_TARGET_KEY)
        if isinstance(target, str):
            return target.encode()
    return await read_file(dispatch, path)


async def restore_entry(dispatch: DispatchFn,
                        path: str,
                        mode: int,
                        blob: bytes,
                        links: LinkView | None = None) -> None:
    """Materialize one tree entry into the working tree.

    A 120000 entry is a symlink whose blob is the target string, so it
    is restored through the namespace rather than written as content:
    writing the blob would leave a regular file spelling the target.

    Whatever is already there goes first, whichever kind it is, because
    git replaces a tree entry rather than merging with it. Two of the
    four combinations are the ones that corrupt state: writing a regular
    blob at a path the namespace holds a link for follows the link and
    lands the content in the file it points at, damaging a path no
    branch touched while the link stays; and linking over a regular file
    leaves that file behind the link, ready to reappear when the link
    goes. The fourth, a link over a link, is the retarget a checkout
    does when a branch moves where a link points: symlink(2) does not
    overwrite, so the old name is removed rather than replaced in place.
    The check is a namespace lookup, so the ordinary file-for-file case
    costs nothing.

    The permission bits are part of the entry, not decoration on it.
    git records exactly one of them, the owner's execute bit, and puts
    it back in both directions: ``chmod -x`` on a ``100755`` path is a
    modification ``restore`` undoes, and ``chmod +x`` on a ``100644``
    one is a modification it undoes the other way. Writing the bytes
    alone left the bit as the working tree had it, so the file came back
    unrunnable and ``status`` went on calling it modified for ever. The
    write is unconditional rather than probed: a stat to decide costs
    the same op as the setattr it would save, and the backends git
    actually runs on apply it natively, so nothing reaches the overlay.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path to materialize at.
        mode (int): the tree entry's mode.
        blob (bytes): the entry's blob content.
        links (LinkView | None): the name plane's link facts, None when
            no namespace is wired.
    """
    linked = links is not None and links.stat_at(path) is not None
    if mode == SYMLINK:
        await remove_file(dispatch, path)
        await dispatch("symlink",
                       PathSpec.from_str_path(path),
                       target=blob.decode("utf-8", errors="replace"))
        return
    if linked:
        await remove_file(dispatch, path)
    await write_file(dispatch, path, blob)
    await dispatch("setattr",
                   PathSpec.from_str_path(path),
                   mode=mode & PERMISSION_BITS)


async def keep_gitlink(dispatch: DispatchFn, stat_path: StatPath, path: str,
                       links: LinkView | None) -> None:
    """Leave a submodule's working tree alone, but make sure it has one.

    A 160000 entry names a commit in another repository, which this one
    does not hold: reading it as a blob is either a miss (an ordinary
    submodule keeps its objects in its own store) or, when the id does
    happen to resolve here, an empty string written over the directory.
    git does neither. It checks out no submodule content at all without
    ``--recurse-submodules``, and all the entry asks of the working tree
    is that a directory stand at the name: an existing one is left
    exactly as it is, untracked work included, a regular file or a link
    is replaced by an empty one, and a missing one is created. Pinned
    against git 2.50.1.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): the data plane's stat, which dereferences.
        path (str): absolute virtual path of the submodule.
        links (LinkView | None): the name plane's link facts, None when
            no namespace is wired.
    """
    linked = links is not None and links.stat_at(path) is not None
    info = None if linked else await stat_path(path)
    if info is not None and info.type is FileType.DIRECTORY:
        return
    if linked or info is not None:
        await remove_file(dispatch, path)
    await ensure_dir(dispatch, path)


async def drop_gitlink(dispatch: DispatchFn, stat_path: StatPath, path: str,
                       name: str, links: LinkView | None) -> str | None:
    """Take a submodule's directory away, or say why it stays.

    The other direction of ``keep_gitlink``, and it is not an unlink:
    what stands at a 160000 entry is a directory, so git calls
    ``rmdir`` and warns rather than failing when that cannot be done.
    An empty one goes; one still holding a checked-out submodule, or
    anything else untracked, stays and is named; a regular file or a
    link at the name is the ``ENOTDIR`` wording of the same warning;
    a name with nothing at it is silent. The switch itself succeeds
    either way, which is the whole point of warning instead of raising.
    Pinned against git 2.50.1.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        stat_path (StatPath): the data plane's stat, which dereferences.
        path (str): absolute virtual path of the submodule.
        name (str): the path as git prints it, repository-relative.
        links (LinkView | None): the name plane's link facts, None when
            no namespace is wired.

    Returns:
        str | None: the warning line to write, None when there is
        nothing to say.
    """
    # A link is answered before the stat, which dereferences: rmdir
    # never follows one, so a link to a directory is ENOTDIR here even
    # though stat would call it a directory.
    if links is not None and links.stat_at(path) is not None:
        return f"warning: unable to rmdir '{name}': Not a directory\n"
    info = await stat_path(path)
    if info is None:
        return None
    if info.type is not FileType.DIRECTORY:
        return f"warning: unable to rmdir '{name}': Not a directory\n"
    if await read_names(dispatch, path):
        return f"warning: unable to rmdir '{name}': Directory not empty\n"
    await dispatch("rmdir", PathSpec.from_str_path(path))
    return None


async def read_range(dispatch: DispatchFn, path: str, offset: int,
                     size: int) -> bytes:
    """Read a byte range of one virtual path.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
        offset (int): first byte to read.
        size (int): how many bytes to read.
    """
    data, _ = await dispatch("read",
                             PathSpec.from_str_path(path),
                             offset=offset,
                             size=size)
    return data if isinstance(data, bytes) else bytes(data)


async def file_size(dispatch: DispatchFn, path: str) -> int | None:
    """A path's byte length, or None when the backend does not know it.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    stat, _ = await dispatch("stat", PathSpec.from_str_path(path))
    return getattr(stat, "size", None)


async def read_optional(dispatch: DispatchFn, path: str) -> bytes | None:
    """Read a path that a repository may legitimately not have.

    ``packed-refs`` and ``HEAD``-adjacent files are absent in perfectly
    valid repositories, so a miss is an answer rather than an error.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    try:
        return await read_file(dispatch, path)
    except MISS_ERRORS:
        return None


async def read_names(dispatch: DispatchFn, path: str) -> list[str]:
    """List a directory, empty when it does not exist.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path of the directory.
    """
    try:
        entries, _ = await dispatch("readdir", PathSpec.from_str_path(path))
    except MISS_ERRORS:
        return []
    return list(entries or [])


async def ensure_dir(dispatch: DispatchFn, path: str) -> None:
    """Create a directory and every missing directory above it.

    Written out rather than delegated to ``mkdir -p`` because the
    parents flag is a per-backend capability: the ops factory only wires
    ``parents=True`` for backends that declare it, so a plain ``mkdir``
    of ``objects/ab`` fails on the rest.

    Existence is probed with a point stat, which on a prefix store misses
    a directory that has no object of its own. That false negative is
    harmless here and the reason this does not need the two-channel
    stat: on such a store a directory is the set of keys under it, so
    creating one again costs a no-op rather than an error.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path of the directory.
    """
    missing: list[str] = []
    current = path.rstrip("/")
    while current and current != "/":
        try:
            await dispatch("stat", PathSpec.from_str_path(current))
            break
        except MISS_ERRORS:
            missing.append(current)
            current = posixpath.dirname(current)
    for target in reversed(missing):
        await dispatch("mkdir", PathSpec.from_str_path(target))


async def exists(dispatch: DispatchFn, path: str) -> bool:
    """Whether a point lookup finds anything at a path.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    try:
        await dispatch("stat", PathSpec.from_str_path(path))
    except MISS_ERRORS:
        return False
    return True


async def write_file(dispatch: DispatchFn, path: str, data: bytes) -> None:
    """Write one virtual path, creating the directories above it.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
        data (bytes): the whole contents.
    """
    await ensure_dir(dispatch, posixpath.dirname(path))
    await dispatch("write", PathSpec.from_str_path(path), data=data)


async def write_once(dispatch: DispatchFn, path: str, data: bytes) -> None:
    """Write a path only if nothing is there yet.

    For content-addressed files, which is every object in the database:
    a path that exists already holds exactly these bytes, because its
    name is a hash of them. Skipping the write is therefore not an
    optimisation but a requirement, since git writes loose objects
    read-only (0444) and rewriting one fails with EACCES. Re-staging an
    unchanged file hits that on the first try.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
        data (bytes): the whole contents.
    """
    if await exists(dispatch, path):
        return
    await write_file(dispatch, path, data)


async def blocking_ancestor(stat_path: StatPath, worktree: str, name: str,
                            links: LinkView | None) -> str | None:
    """The nearest component above an entry that is not a directory.

    An entry's path is only a way through the working tree while every
    component above it is a directory. Anything else standing on one --
    a symlink, a regular file, tracked or not -- is not a way through,
    and the two directions take it differently. Writing the entry
    *replaces* it with the directory the entry needs, leaving whatever
    a link pointed at exactly as it was; removing the entry does
    nothing at all, because the path never led there. That is git's
    ``create_directories`` and ``check_leading_path``, and both halves
    were probed against git 2.50.1.

    The namespace is asked before the data plane, and the order is the
    whole point: ``stat_path`` dereferences, so a link to a directory
    stats as a directory and the walk would carry on straight through
    it. Only the name plane can say that the component is a link.

    An exact-path lookup cannot see any of this, since what is in the
    way sits above the name being looked up rather than on it.

    Args:
        stat_path (StatPath): the data plane's stat, which dereferences.
        worktree (str): absolute virtual path of the working tree root.
        name (str): the entry, repository-relative.
        links (LinkView | None): the name plane's link facts, None when
            no namespace is wired.

    Returns:
        str | None: absolute virtual path of the nearest such component,
        None when every component above the entry is a directory.
    """
    current = worktree
    for part in name.split("/")[:-1]:
        current = posixpath.join(current, part)
        if links is not None and links.stat_at(current) is not None:
            return current
        info = await stat_path(current)
        if info is not None and info.type is not FileType.DIRECTORY:
            return current
    return None


async def remove_file(dispatch: DispatchFn, path: str) -> None:
    """Delete one virtual path, tolerating one that is already gone.

    A miss is an answer rather than an error for every caller here:
    unstaging a path deletes whatever ref or lock may or may not exist,
    and a checkout removes files the other branch does not have.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path.
    """
    try:
        await dispatch("unlink", PathSpec.from_str_path(path))
    except MISS_ERRORS as exc:
        logger.debug("nothing to remove at %s: %s", path, exc)


async def rename_path(dispatch: DispatchFn, source: str, target: str) -> None:
    """Move one virtual path, file or directory, to another name.

    The mount's own rename, so a directory moves with everything under
    it, tracked or not, which is what ``git mv`` does with a directory.
    The destination's directory is not created: git's rename fails when
    it is missing, and the caller words that failure.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        source (str): absolute virtual path to move.
        target (str): absolute virtual path to move it to.
    """
    await dispatch("rename",
                   PathSpec.from_str_path(source),
                   dst=PathSpec.from_str_path(target))


def refuse_mount(mounts: MountView | None, path: str) -> None:
    """Refuse a removal that would take a nested mount with it.

    A mount nested inside the working tree is served by another
    resource, and ``readdir`` merges it into the parent's listing, so a
    walk that empties a directory walks straight into the child backend
    and unlinks what is in it. No branch ever recorded any of that, and
    the ``rmdir`` that follows takes the mount root itself. Asking the
    mount table is the only way to see the boundary: the parent
    backend cannot.

    Two questions, two fields, the way ``MountView`` says: the
    boundary is *avoided* by the unfiltered list, so a mount this
    session cannot see still blocks the removal, and it is *named*
    from the visible one, since naming a hidden mount is what the hide
    exists to prevent.

    Args:
        mounts (MountView | None): the name plane's mount boundaries,
            None when no namespace is wired.
        path (str): absolute virtual path about to be removed.
    """
    if mounts is None:
        return
    if mounts.is_root(path):
        raise MountInWayError(path, path)
    if not mounts.descendants(path):
        return
    named = sorted(mounts.visible_descendants(path))
    raise MountInWayError(path, named[0] if named else None)


async def refuse_replaced_mounts(stat_path: StatPath, worktree: str,
                                 names: list[str], links: LinkView | None,
                                 mounts: MountView | None) -> None:
    """Ask of every destination first what the write loop would meet later.

    ``remove_tree`` refuses a directory holding a mount, but the loop
    reaches one entry at a time, so a refusal there leaves the entries
    already written standing on the target's content with HEAD and the
    index still where they were. Asking first is the shape every other
    collision check in these verbs already has: name what is in the way
    and change nothing. The condition mirrors the write loop's exactly,
    a link included, so a destination the loop would not clear is not
    refused here either.

    Args:
        stat_path (StatPath): the data plane's stat, which dereferences.
        worktree (str): absolute virtual path of the working tree root.
        names (list[str]): repository-relative paths about to be
            written.
        links (LinkView | None): the name plane's link facts, None when
            no namespace is wired.
        mounts (MountView | None): the name plane's mount boundaries,
            None when no namespace is wired.
    """
    if mounts is None:
        return
    for name in sorted(names):
        where = posixpath.join(worktree, name)
        if links is not None and links.stat_at(where) is not None:
            continue
        info = await stat_path(where)
        if info is not None and info.type is FileType.DIRECTORY:
            refuse_mount(mounts, where)


async def remove_tree(dispatch: DispatchFn, path: str, links: LinkView | None,
                      mounts: MountView | None) -> None:
    """Delete a path and everything under it, tracked or not.

    git replaces a tree entry rather than merging with it, so a
    directory standing where the source keeps a file goes entirely.
    That is one of the few places git removes a file it never tracked:
    an untracked child keeps the directory alive after the tracked ones
    are gone, and restoring the file over it would otherwise fail with
    the index already changed.

    A file and an absent path both walk out through the same two steps,
    since ``readdir`` reads a non-directory as nothing there and
    ``rmdir`` refuses it.

    A child that is a symlink is unlinked, never descended into. The
    name plane has to say so, because ``readdir`` dereferences: a link
    to a directory lists that directory's contents, and recursing on
    them deletes a tree outside the one being replaced. ``rm -r`` does
    not follow a link either, so a branch recording a file where the
    working tree has a directory takes the link away with the directory
    and leaves whatever it pointed at exactly as it was. Pinned against
    git 2.50.1.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path to clear.
        links (LinkView | None): the name plane's link facts, None when
            no namespace is wired.
        mounts (MountView | None): the name plane's mount boundaries,
            None when no namespace is wired.
    """
    # Before the first deletion rather than at the boundary itself, so
    # a mount deep under the directory costs the caller nothing: the
    # scan sees every depth at once and the tree is still whole when
    # it refuses.
    refuse_mount(mounts, path)
    for entry in await read_names(dispatch, path):
        # A listing answers in whole paths, so the child is rebuilt from
        # the basename the way every other walk here does.
        name = entry.rstrip("/").rsplit("/", 1)[-1]
        if not name:
            continue
        child = posixpath.join(path, name)
        if links is not None and links.stat_at(child) is not None:
            await remove_file(dispatch, child)
            continue
        await remove_tree(dispatch, child, links, mounts)
    try:
        await dispatch("rmdir", PathSpec.from_str_path(path))
    except MISS_ERRORS as exc:
        # Not a directory, or already gone: the path is whatever one file
        # it is, and remove_file tolerates an absent one. A directory the
        # walk above was supposed to empty raises OSError(ENOTEMPTY),
        # which is not a miss and stays raised.
        logger.debug("no directory to remove at %s: %s", path, exc)
        await remove_file(dispatch, path)


async def remove_empty_parents(dispatch: DispatchFn, path: str, stop: str,
                               mounts: MountView | None) -> None:
    """Drop the directories a deletion left empty, up to a root.

    git removes a directory the moment its last tracked file is deleted
    or restored away, so ``rm -r docs`` leaves no ``docs/`` behind. The
    walk stops at the first directory that still holds something and
    never touches ``stop`` itself.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        path (str): absolute virtual path of the file that was removed.
        stop (str): absolute virtual path of the working tree root.
        mounts (MountView | None): the name plane's mount boundaries,
            None when no namespace is wired.
    """
    root = stop.rstrip("/") or "/"
    current = posixpath.dirname(path)
    while current != root and current.startswith(root):
        # A mount root is not a directory git made, and an empty one is
        # still a whole backend: removing it here would destroy the
        # store behind it as a side effect of tidying up. The walk
        # stops rather than refusing, because nothing the caller asked
        # for has failed.
        if mounts is not None and mounts.is_root(current):
            return
        if await read_names(dispatch, current):
            return
        try:
            await dispatch("rmdir", PathSpec.from_str_path(current))
        except MISS_ERRORS as exc:
            logger.debug("no directory to remove at %s: %s", current, exc)
            return
        current = posixpath.dirname(current)
