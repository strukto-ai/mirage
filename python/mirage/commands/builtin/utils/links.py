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

import functools
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any

from mirage.commands.config import CommandIO, CommandOpts
from mirage.errors.fs import eloop
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import CycleError, gnu_basename, resolve_path
from mirage.view.types import LinkView, MountView

logger = logging.getLogger(__name__)

_MISSES = (FileNotFoundError, NotADirectoryError)


def link_location(links: LinkView, virtual: str) -> str:
    """Where a name stands as lstat reaches it: every link above its final
    name followed, the name itself kept.

    The walk the kernel gives a path before a call that does not follow
    its final name, and the key the table files a link under, since every
    link is keyed by its resolved parent. A path ending in a slash resolves
    whole: POSIX reads ``dlink/`` as ``dlink/.``.

    Args:
        links (LinkView): the namespace's symlink facts.
        virtual (str): an absolute virtual path.

    Raises:
        CycleError: a link loop stands in the walk (ELOOP).
    """
    head, _, name = virtual.rpartition("/")
    if not name:
        return links.resolve(virtual)
    return f"{links.resolve(head or '/').rstrip('/')}/{name}"


def owed_names(links: LinkView, directory: str) -> list[str]:
    """The names the links owe a directory: each link standing in it, and
    each directory holding one further down.

    No backend can list either, and the second may be one no backend
    serves at all (a link made below a directory chain that holds no key),
    so these are the names the dispatcher merges into its own listing,
    derived from the same table.

    Args:
        links (LinkView): the namespace's symlink facts.
        directory (str): the directory's virtual path, its links resolved.
    """
    base = directory.rstrip("/") + "/"
    return sorted(
        {path[len(base) :].split("/", 1)[0] for path, _ in links.subtree(base)}
    )


def name_location(links: LinkView, path: PathSpec, cwd: str) -> str | None:
    """Where the name an operand was typed as stands, as lstat reaches it.

    Every component but the last resolves through the links, as the
    kernel walks any path, so ``dl/tl.gz`` with ``dl`` a link to ``dir``
    stands at ``dir/tl.gz``: the table keys every link by that resolved
    parent. None where the last component resolves as well, which is a
    name typed with a trailing slash or ending in a dot, and where the
    walk already failed.

    Args:
        links (LinkView): the namespace's symlink facts.
        path (PathSpec): the operand, whether the router followed it or not.
        cwd (str): the directory a relative name resolves against.
    """
    typed = path.raw_path or path.virtual
    if (
        path.walk_error is not None
        or typed.endswith("/")
        or typed.rsplit("/", 1)[-1] in (".", "..")
    ):
        return None
    return link_location(links, resolve_path(typed, cwd))


def typed_link(links: LinkView, path: PathSpec, cwd: str) -> FileStat | None:
    """The link standing at the name an operand was typed as, its own row.

    The router follows an operand through its link before the command
    runs, which leaves ``virtual`` at the target and the name in
    ``raw_path``; a command that acts on the name itself (cp -P, gzip's
    O_NOFOLLOW open) asks here. None where no link stands at the name.

    Args:
        links (LinkView): the namespace's symlink facts.
        path (PathSpec): the operand.
        cwd (str): the directory a relative name resolves against.
    """
    where = name_location(links, path, cwd)
    return None if where is None else links.stat_at(where)


@dataclass(frozen=True, slots=True)
class LinkResolver:
    """The namespace's links as a command meets a name, and the dispatcher past
    them.

    A link is invisible to every backend, so a command bound to one
    mount needs the links to tell a name that stands on one, and the
    dispatcher to act where the link leads or where it stands: the target may
    live on any mount, and so may the link.

    Attributes:
        links (LinkView): the namespace's symlink facts.
        dispatch (DispatchFn): the dispatcher, which reaches every mount.
        cwd (str): the directory a typed name resolves against.
    """

    links: LinkView
    dispatch: DispatchFn
    cwd: str

    def link_at(self, path: PathSpec) -> str | None:
        """Where the link standing at an operand's name sits, None where
        no link stands there.

        Args:
            path (PathSpec): the operand.
        """
        where = name_location(self.links, path, self.cwd)
        if where is None or self.links.stat_at(where) is None:
            return None
        return where

    def vanished(self, path: PathSpec) -> bool:
        """Whether the link the router followed an operand through is gone.

        The router follows every operand before the command runs, so an
        earlier operand that removed the link (``gunzip -f l.gz l.gz``)
        leaves a later one at the old target: GNU opens each name when
        it reaches it, and finds nothing there.

        Args:
            path (PathSpec): the operand, as the router followed it.
        """
        where = name_location(self.links, path, self.cwd)
        return (
            where is not None
            and where != path.virtual
            and self.links.stat_at(where) is None
        )

    def target(self, link: str) -> str:
        """Where a link leads, every link on the way followed.

        Args:
            link (str): the link's virtual path.

        Raises:
            DotWalkLoop: the chain loops (ELOOP), an OSError a walker
                reports as it reports any failed stat.
        """
        return _or_eloop(self.links.resolve, link)

    async def stat(self, virtual: str) -> FileStat:
        """What a name leads to, its stat through the dispatcher.

        Args:
            virtual (str): the name's virtual path, on any mount.
        """
        stat: FileStat
        stat, _ = await self.dispatch("stat", PathSpec.from_str_path(virtual))
        return stat

    async def readdir(self, virtual: str) -> list[str]:
        """A directory's entries through the dispatcher, links among them.

        Args:
            virtual (str): the directory's virtual path, on any mount.
        """
        entries, _ = await self.dispatch(
            "readdir", PathSpec.from_str_path(virtual)
        )
        return list(entries)

    async def lstat(self, path: PathSpec) -> FileStat:
        """A name's own stat at the dispatcher: a link's, not its target's.

        Args:
            path (PathSpec): the name.
        """
        stat: FileStat
        stat, _ = await self.dispatch("stat", path, nofollow=True)
        return stat

    async def read(self, virtual: str) -> AsyncIterator[bytes]:
        """What a name leads to, read through the dispatcher, which follows it.

        Args:
            virtual (str): the name's virtual path.
        """
        data, _ = await self.dispatch("read", PathSpec.from_str_path(virtual))
        yield data

    async def write(self, virtual: str, data: bytes) -> None:
        """Write a file on the mount that owns the name.

        Args:
            virtual (str): the file's virtual path.
            data (bytes): its whole content.
        """
        await self.dispatch(
            "write", PathSpec.from_str_path(virtual), data=data
        )

    async def unlink(self, virtual: str) -> None:
        """Remove the name itself, a link rather than what it leads to.

        Args:
            virtual (str): the name's virtual path.
        """
        await self.dispatch("unlink", PathSpec.from_str_path(virtual))


def _or_eloop(resolve: Callable[[str], str], virtual: str) -> str:
    try:
        return resolve(virtual)
    except CycleError:
        raise eloop(virtual) from None


def _named(row: FileStat, virtual: str) -> FileStat:
    name = gnu_basename(virtual)
    return row if row.name == name else row.model_copy(update={"name": name})


def _rebased(entry: str, where: str, base: str) -> str:
    """An entry the dispatcher listed under ``where``, named under ``base``.

    Args:
        entry (str): the listed entry's virtual path.
        where (str): the directory the dispatcher listed.
        base (str): the directory the caller asked for, without a slash.
    """
    root = where.rstrip("/") + "/"
    rest = (
        entry[len(root) :] if entry.startswith(root) else gnu_basename(entry)
    )
    return f"{base}/{rest}"


def serves(mounts: MountView | None, prefix: str, virtual: str) -> bool:
    """Whether the mount at ``prefix`` is the one serving ``virtual``.

    Args:
        mounts (MountView | None): the mount boundaries, None where one
            mount serves every path.
        prefix (str): the mount's prefix, without a trailing slash.
        virtual (str): an absolute virtual path.
    """
    return mounts is None or mounts.root_of(virtual).rstrip("/") == prefix


def landing_root(
    mounts: MountView, links: LinkView | None, virtual: str
) -> str:
    """The mount a walked path lands on, every link on it followed.

    A mount is mirage's filesystem, so this stands for the device stat(2)
    reports, which ``find -xdev`` compares with the start point's: a link
    onto another mount leaves it as a mount root does (findutils 4.10).

    Args:
        mounts (MountView): the mount boundaries.
        links (LinkView | None): the namespace's links, None where it
            holds none.
        virtual (str): absolute virtual path of a directory the walk
            reached, which resolves.
    """
    return mounts.root_of(
        links.resolve(virtual) if links is not None else virtual
    )


async def _linked_stat(
    stat: Callable[..., Awaitable[FileStat]],
    links: LinkView,
    dispatch: DispatchFn,
    owns: Callable[[str], bool],
    accessor: Any,
    path: PathSpec,
    *args: Any,
    **kwargs: Any,
) -> FileStat:
    here = path.virtual
    where = _or_eloop(functools.partial(link_location, links), here)
    row = None if here.endswith("/") else links.stat_at(where)
    if row is not None:
        return row
    if where.rstrip("/") != here.rstrip("/") or not owns(where):
        found, _ = await dispatch(
            "stat", PathSpec.from_str_path(where), nofollow=True
        )
        return _named(found, here)
    try:
        return await stat(accessor, path, *args, **kwargs)
    except _MISSES as exc:
        if not owed_names(links, here):
            raise
        logger.debug("%s: a directory for the links below it: %s", here, exc)
        return FileStat(name=gnu_basename(here), type=FileType.DIRECTORY)


async def _linked_readdir(
    readdir: Callable[..., Awaitable[list[str]]],
    links: LinkView,
    dispatch: DispatchFn,
    owns: Callable[[str], bool],
    accessor: Any,
    path: PathSpec,
    *args: Any,
    **kwargs: Any,
) -> list[str]:
    here = path.virtual.rstrip("/") or "/"
    where = _or_eloop(links.resolve, here)
    base = here.rstrip("/")
    if where != here or not owns(where):
        listed, _ = await dispatch("readdir", PathSpec.from_str_path(where))
        return [_rebased(entry, where, base) for entry in listed]
    owed = owed_names(links, here)
    try:
        entries: list[str] = await readdir(accessor, path, *args, **kwargs)
    except _MISSES as exc:
        if not owed:
            raise
        logger.debug("%s: listed for the links below it: %s", here, exc)
        entries = []
    if not owed:
        return entries
    present = {entry.rstrip("/") for entry in entries}
    return [
        *entries,
        *(f"{base}/{n}" for n in owed if f"{base}/{n}" not in present),
    ]


async def _linked_tree(
    read_tree: Callable[..., Awaitable[dict[str, FileStat] | None]],
    links: LinkView,
    accessor: Any,
    path: PathSpec,
    *args: Any,
    **kwargs: Any,
) -> dict[str, FileStat] | None:
    found = await read_tree(accessor, path, *args, **kwargs)
    base = path.virtual.rstrip("/") + "/"
    rows = links.subtree(base)
    if found is None or not rows:
        return found
    return {**found, **{key[len(base) :]: row for key, row in rows}}


def with_links(
    ops: CommandIO,
    links: LinkView | None,
    dispatch: DispatchFn | None,
    owns: Callable[[str], bool],
) -> CommandIO:
    """``ops`` whose stat, readdir and subtree read see the namespace's
    links, the way the dispatcher's own do.

    No backend stores a link, so a mount's table asked about a name a link
    stands at answers ENOENT, its listing leaves the link out, and a name
    below a link to a directory reaches nothing. Here the table answers
    once for every command: ``stat`` is lstat (a link's own row, and the
    dispatcher's answer for a name a link above it leads elsewhere),
    ``readdir`` names the links among the backend's entries and lists a
    directory a link leads to through the dispatcher, ``read_tree``
    carries the links under its root, and a directory that holds only a
    link stats and lists as the dispatcher's does. What a command does
    with a link, follow it, copy it or leave it, stays its own rule.

    Args:
        ops (CommandIO): the mount's table.
        links (LinkView | None): the namespace's symlink facts.
        dispatch (DispatchFn | None): the dispatcher, which reaches the
            mount a link leads to.
        owns (Callable[[str], bool]): whether this mount serves a path;
            one a link led to on another mount goes to the dispatcher.
    """
    if links is None or dispatch is None:
        return ops
    return replace(
        ops,
        stat=functools.partial(_linked_stat, ops.stat, links, dispatch, owns),
        readdir=functools.partial(
            _linked_readdir, ops.readdir, links, dispatch, owns
        ),
        read_tree=(
            functools.partial(_linked_tree, ops.read_tree, links)
            if ops.read_tree is not None
            else None
        ),
    )


def link_resolver(opts: CommandOpts) -> LinkResolver | None:
    """The link resolver an invocation carries: None when the namespace holds
    no link, the fast path, or outside a workspace.

    Args:
        opts (CommandOpts): the invocation's context.
    """
    links = opts.ns.links if opts.ns is not None else None
    if links is None or opts.dispatch is None:
        return None
    return LinkResolver(
        links=links, dispatch=opts.dispatch, cwd=opts.cwd.virtual
    )


__all__ = [
    "LinkResolver",
    "link_location",
    "link_resolver",
    "name_location",
    "owed_names",
    "serves",
    "typed_link",
    "with_links",
]
