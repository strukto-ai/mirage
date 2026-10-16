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

from mirage.commands.cli.builtin.git.constants import PERMISSION_BITS, SYMLINK
from mirage.commands.cli.builtin.git.errors import MountInWayError
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import eexist
from mirage.types import LINK_TARGET_KEY, FileStat, FileType, PathSpec
from mirage.utils.remnants import entry_name
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)


async def read_file(vfs: Files, path: PathSpec) -> bytes:
    """Read one virtual path through the session's files.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
    """
    data = await vfs.read(path)
    return data if isinstance(data, bytes) else bytes(data)


async def stat_of(vfs: Files, path: PathSpec) -> FileStat | None:
    """What stands at a path, a link followed, None when nothing does.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
    """
    try:
        return await vfs.stat(path)
    except MISS_ERRORS:
        return None


async def lstat(vfs: Files, path: PathSpec) -> FileStat | None:
    """What sits at a path, a link reported as itself, None when
    nothing does.

    git lstats the working tree, so a symlink is an entry in its own
    right: it records mode 120000 and the target string, and reports a
    link to nothing as untracked rather than as absent.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
    """
    try:
        return await vfs.stat(path, nofollow=True)
    except MISS_ERRORS:
        return None


async def is_link(vfs: Files, path: PathSpec) -> bool:
    """Whether a path names a symlink itself, the lstat a walk asks
    before it follows anything.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
    """
    info = await lstat(vfs, path)
    return info is not None and info.type is FileType.SYMLINK


async def entry_bytes(vfs: Files, path: PathSpec, info: FileStat) -> bytes:
    """The bytes git stores for one working-tree entry.

    A symlink's blob is its target string, not what the target holds, so
    reading through the link would stage a second copy of the target
    under mode 100644 and then report the entry modified forever after
    (the staged blob and the bytes behind the link never match). The
    target is namespace state, which is why it arrives on the stat
    rather than from a read.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
        info (FileStat): what the walk saw at that path, lstat-style.
    """
    if info.type is FileType.SYMLINK:
        target = info.extra.get(LINK_TARGET_KEY)
        if isinstance(target, str):
            return target.encode()
    return await read_file(vfs, path)


async def restore_entry(
    vfs: Files,
    path: PathSpec,
    mode: int,
    blob: bytes,
) -> None:
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
    The check is one lstat, which the listing the checkout walked
    usually answers.

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
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path to materialize at.
        mode (int): the tree entry's mode.
        blob (bytes): the entry's blob content.
    """
    linked = await is_link(vfs, path)
    if mode == SYMLINK:
        await remove_file(vfs, path)
        # symlink(2) needs the directory above the entry, as the write
        # below does, so a link alone in a new directory gets one too.
        await ensure_dir(vfs, path.parent)
        await vfs.symlink(path, blob.decode("utf-8", errors="replace"))
        return
    if linked:
        await remove_file(vfs, path)
    await write_file(vfs, path, blob)
    await vfs.setattr(path, mode=mode & PERMISSION_BITS)


async def keep_gitlink(vfs: Files, path: PathSpec) -> None:
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
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the submodule.
    """
    linked = await is_link(vfs, path)
    info = None if linked else await stat_of(vfs, path)
    if info is not None and info.type is FileType.DIRECTORY:
        return
    if linked or info is not None:
        await remove_file(vfs, path)
    await ensure_dir(vfs, path)


async def drop_gitlink(vfs: Files, path: PathSpec, name: str) -> str | None:
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
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the submodule.
        name (str): the path as git prints it, repository-relative.

    Returns:
        str | None: the warning line to write, None when there is
        nothing to say.
    """
    # A link is answered before the stat, which dereferences: rmdir
    # never follows one, so a link to a directory is ENOTDIR here even
    # though stat would call it a directory.
    if await is_link(vfs, path):
        return f"warning: unable to rmdir '{name}': Not a directory\n"
    info = await stat_of(vfs, path)
    if info is None:
        return None
    if info.type is not FileType.DIRECTORY:
        return f"warning: unable to rmdir '{name}': Not a directory\n"
    if await read_names(vfs, path):
        return f"warning: unable to rmdir '{name}': Directory not empty\n"
    await vfs.rmdir(path)
    return None


async def read_range(
    vfs: Files, path: PathSpec, offset: int, size: int
) -> bytes:
    """Read a byte range of one virtual path.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
        offset (int): first byte to read.
        size (int): how many bytes to read.
    """
    data = await vfs.read(path, offset=offset, size=size)
    return data if isinstance(data, bytes) else bytes(data)


async def file_size(vfs: Files, path: PathSpec) -> int | None:
    """A path's byte length, or None when the backend does not know it.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
    """
    return (await vfs.stat(path)).size


async def read_optional(vfs: Files, path: PathSpec) -> bytes | None:
    """Read a path that a repository may legitimately not have.

    ``packed-refs`` and ``HEAD``-adjacent files are absent in perfectly
    valid repositories, so a miss is an answer rather than an error.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
    """
    try:
        return await read_file(vfs, path)
    except MISS_ERRORS:
        return None


async def read_names(vfs: Files, path: PathSpec) -> list[str]:
    """List a directory, empty when it does not exist.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the directory.
    """
    try:
        return await vfs.readdir(path)
    except MISS_ERRORS:
        return []


async def ensure_dir(vfs: Files, path: PathSpec) -> None:
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
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the directory.
    """
    missing: list[PathSpec] = []
    current = path
    while current.virtual != "/":
        try:
            await vfs.stat(current)
            break
        except MISS_ERRORS:
            missing.append(current)
            current = current.parent
    for target in reversed(missing):
        await vfs.mkdir(target)


async def exists(vfs: Files, path: PathSpec) -> bool:
    """Whether a point lookup finds anything at a path.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
    """
    try:
        await vfs.stat(path)
    except MISS_ERRORS:
        return False
    return True


async def write_file(vfs: Files, path: PathSpec, data: bytes) -> None:
    """Write one virtual path, creating the directories above it.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
        data (bytes): the whole contents.
    """
    await ensure_dir(vfs, path.parent)
    await vfs.write(path, data)


async def take_lock(vfs: Files, path: PathSpec) -> None:
    """Take a file's lock and let it go, as git does before rewriting it.

    git creates ``<path>.lock`` before it rewrites the index or the
    config, even when nothing in them changes, so a read-only repository
    refuses the verb there before it looks any further. Creating the
    lock and removing it is that refusal, and it leaves the file itself
    alone, so a write another session makes to it is never undone. A
    lock already there is another writer's, which git refuses and so
    does this, untouched. The look and the create are two ops, since the
    dispatcher has no exclusive create.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the file the lock guards.

    Raises:
        FileExistsError: the lock is already there.
    """
    lock = PathSpec.from_str_path(
        f"{path.dotted or path.virtual}.lock", cwd="/"
    )
    if await exists(vfs, lock):
        raise eexist(lock)
    await vfs.write(lock, b"")
    await remove_file(vfs, lock)


async def write_once(vfs: Files, path: PathSpec, data: bytes) -> None:
    """Write a path only if nothing is there yet.

    For content-addressed files, which is every object in the database:
    a path that exists already holds exactly these bytes, because its
    name is a hash of them. Skipping the write is therefore not an
    optimisation but a requirement, since git writes loose objects
    read-only (0444) and rewriting one fails with EACCES. Re-staging an
    unchanged file hits that on the first try.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
        data (bytes): the whole contents.
    """
    if await exists(vfs, path):
        return
    await write_file(vfs, path, data)


async def blocking_ancestor(
    vfs: Files, worktree: PathSpec, name: str
) -> PathSpec | None:
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

    The lstat is asked before the stat, and the order is the whole
    point: ``stat`` dereferences, so a link to a directory stats as a
    directory and the walk would carry on straight through it.

    An exact-path lookup cannot see any of this, since what is in the
    way sits above the name being looked up rather than on it.

    Args:
        vfs (Files): the session's files.
        worktree (PathSpec): absolute virtual path of the working tree root.
        name (str): the entry, repository-relative.

    Returns:
        PathSpec | None: absolute virtual path of the nearest such component,
        None when every component above the entry is a directory.
    """
    current = worktree
    for part in name.split("/")[:-1]:
        current = current.join(part)
        if await is_link(vfs, current):
            return current
        info = await stat_of(vfs, current)
        if info is not None and info.type is not FileType.DIRECTORY:
            return current
    return None


async def remove_file(vfs: Files, path: PathSpec) -> None:
    """Delete one virtual path, tolerating one that is already gone.

    A miss is an answer rather than an error for every caller here:
    unstaging a path deletes whatever ref or lock may or may not exist,
    and a checkout removes files the other branch does not have.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path.
    """
    try:
        await vfs.unlink(path)
    except MISS_ERRORS as exc:
        logger.debug("nothing to remove at %s: %s", path, exc)


async def rename_path(vfs: Files, source: PathSpec, target: PathSpec) -> None:
    """Move one virtual path, file or directory, to another name.

    The mount's own rename, so a directory moves with everything under
    it, tracked or not, which is what ``git mv`` does with a directory.
    The destination's directory is not created: git's rename fails when
    it is missing, and the caller words that failure.

    Args:
        vfs (Files): the session's files.
        source (PathSpec): absolute virtual path to move.
        target (PathSpec): absolute virtual path to move it to.
    """
    await vfs.rename(source, target)


def refuse_mount(vfs: Files, path: PathSpec) -> None:
    """Refuse a removal that would take a nested mount with it.

    A mount nested inside the working tree is served by another
    VFS, and ``readdir`` merges it into the parent's listing, so a
    walk that empties a directory walks straight into the child backend
    and unlinks what is in it. No branch ever recorded any of that, and
    the ``rmdir`` that follows takes the mount root itself. Asking the
    mount table is the only way to see the boundary: the parent
    backend cannot.

    A mount this session cannot see still blocks the removal:
    ``submounts`` reports it by the nearest folder above it the session
    sees, which is not a mount root, so only a visible one is named,
    naming a hidden mount being what the hide exists to prevent.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path about to be removed.
    """
    if vfs.is_mount(path):
        raise MountInWayError(path.virtual, path.virtual)
    below = vfs.submounts(path)
    if not below:
        return
    named = next((root for root in below if vfs.is_mount(root)), None)
    raise MountInWayError(path.virtual, named)


async def refuse_replaced_mounts(
    vfs: Files, worktree: PathSpec, names: list[str]
) -> None:
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
        vfs (Files): the session's files.
        worktree (PathSpec): absolute virtual path of the working tree root.
        names (list[str]): repository-relative paths about to be
            written.
    """
    for name in sorted(names):
        where = worktree.join(name)
        if await is_link(vfs, where):
            continue
        info = await stat_of(vfs, where)
        if info is not None and info.type is FileType.DIRECTORY:
            refuse_mount(vfs, where)


async def remove_tree(vfs: Files, path: PathSpec) -> None:
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

    A child that is a symlink is unlinked, never descended into. Its
    lstat has to say so, because ``readdir`` dereferences: a link
    to a directory lists that directory's contents, and recursing on
    them deletes a tree outside the one being replaced. ``rm -r`` does
    not follow a link either, so a branch recording a file where the
    working tree has a directory takes the link away with the directory
    and leaves whatever it pointed at exactly as it was. Pinned against
    git 2.50.1.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path to clear.
    """
    # Before the first deletion rather than at the boundary itself, so
    # a mount deep under the directory costs the caller nothing: the
    # scan sees every depth at once and the tree is still whole when
    # it refuses.
    refuse_mount(vfs, path)
    for entry in await read_names(vfs, path):
        # A listing answers in whole paths, so the child is rebuilt from
        # the basename the way every other walk here does.
        name = entry_name(entry)
        if not name:
            continue
        child = path.join(name)
        if await is_link(vfs, child):
            await remove_file(vfs, child)
            continue
        await remove_tree(vfs, child)
    try:
        await vfs.rmdir(path)
    except MISS_ERRORS as exc:
        # Not a directory, or already gone: the path is whatever one file
        # it is, and remove_file tolerates an absent one. A directory the
        # walk above was supposed to empty raises OSError(ENOTEMPTY),
        # which is not a miss and stays raised.
        logger.debug("no directory to remove at %s: %s", path, exc)
        await remove_file(vfs, path)


async def remove_empty_parents(
    vfs: Files, path: PathSpec, stop: PathSpec
) -> None:
    """Drop the directories a deletion left empty, up to a root.

    git removes a directory the moment its last tracked file is deleted
    or restored away, so ``rm -r docs`` leaves no ``docs/`` behind. The
    walk stops at the first directory that still holds something and
    never touches ``stop`` itself.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): absolute virtual path of the file that was removed.
        stop (PathSpec): absolute virtual path of the working tree root.
    """
    root = stop.virtual.rstrip("/") or "/"
    current = path.parent
    while current.virtual != root and current.virtual.startswith(root):
        # A mount root is not a directory git made, and an empty one is
        # still a whole backend: removing it here would destroy the
        # store behind it as a side effect of tidying up. The walk
        # stops rather than refusing, because nothing the caller asked
        # for has failed.
        if vfs.is_mount(current):
            return
        if await read_names(vfs, current):
            return
        try:
            await vfs.rmdir(current)
        except MISS_ERRORS as exc:
            logger.debug("no directory to remove at %s: %s", current, exc)
            return
        current = current.parent
