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
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from mirage.commands.builtin.utils.paths import resolve_path_stat
from mirage.commands.config import Context
from mirage.context.session_context import current_caller
from mirage.errors.fs import eloop
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, PathSpec, Visibility
from mirage.utils.hidden import path_visible
from mirage.utils.path import (
    CycleError,
    gnu_basename,
    norm_dir,
    owner_prefix,
    resolve_path,
)
from mirage.view.namespace_view import namespace_names
from mirage.view.types import FollowOperands, LinkView, MountView
from mirage.workspace.files import Files, namespace_of
from mirage.workspace.types import MountRow

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
        data, _ = await self.dispatch(
            "read", PathSpec.from_str_path(virtual), stream=True
        )
        async for chunk in chunks(data):
            yield chunk

    async def write(self, virtual: str, data: ByteSource) -> None:
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


def link_view(files: Files | None) -> LinkView | None:
    """The symlink facts a walk goes by, read off the session's files, or
    None outside a workspace.

    Filtered by the hides of the session the files run as, as the
    dispatcher's own answers are: a hidden link, or one that leads where
    the session cannot see, has no row, no listing entry and no target.
    Resolving a hidden path leaves it as typed, for the dispatcher to
    refuse; a visible one resolves, so a walker judges where it lands.

    Args:
        files (Files | None): the session's files.
    """
    if files is None:
        return None
    namespace = namespace_of(files)
    table = namespace.links
    if table is None:
        return None
    seen, links = files, table

    def stat_at(virtual: str) -> FileStat | None:
        return (
            links.link_stat_at(virtual) if seen.is_visible(virtual) else None
        )

    def subtree(directory: str) -> list[tuple[str, FileStat]]:
        return [
            (path, row)
            for path, row in links.link_stats_below(directory)
            if seen.is_visible(path)
        ]

    def resolve(virtual: str) -> str:
        if not path_visible(namespace.vis(), virtual):
            return virtual
        return posixpath.normpath(links.follow(virtual))

    async def exists(virtual: str) -> bool:
        spec = PathSpec.from_str_path(virtual, cwd="/")
        try:
            return await resolve_path_stat(seen.dispatch, spec) is not None
        except (OSError, ValueError) as exc:
            logger.debug("link probe at %s failed: %s", virtual, exc)
            return False

    async def target_stat(virtual: str | PathSpec) -> FileStat | None:
        path = virtual.virtual if isinstance(virtual, PathSpec) else virtual
        if not seen.is_visible(path):
            return None
        try:
            return await seen.stat(posixpath.normpath(links.follow(path)))
        except (CycleError, *_MISSES) as exc:
            logger.debug("link target of %s has no row: %s", path, exc)
            return None

    return LinkView(
        stat_at=stat_at,
        subtree=subtree,
        resolve=resolve,
        exists=exists,
        target_stat=target_stat,
    )


def mount_view(
    files: Files | None, crossing: bool = False
) -> MountView | None:
    """Where the mount boundaries are, read off the session's files, or
    None outside a workspace.

    Every mount below a path, hidden or not, is a boundary a backend's
    own walk stops at: a mount the session cannot see still shadows the
    parent backend's keys under its prefix. Only the visible ones are
    ever named. A walk through the dispatcher (``crossing``) descends
    into each mount itself, so it has no boundary to stop at: no mount
    below a path, and no mount root; and it takes no mount's shortcut,
    so no mount answers a function for it, caps its globs or narrows
    its search.

    Args:
        files (Files | None): the session's files.
        crossing (bool): the walk goes through the dispatcher.
    """
    if files is None:
        return None
    namespace = namespace_of(files)

    def below(virtual: str) -> list[str]:
        if crossing:
            return []
        base = norm_dir(virtual)
        return [
            m.prefix.rstrip("/") or "/"
            for m in sorted(namespace.mounts(), key=lambda m: m.prefix)
            if m.prefix != base and m.prefix.startswith(base)
        ]

    def visible_below(virtual: str) -> list[str]:
        vis = namespace.vis()
        return [root for root in below(virtual) if path_visible(vis, root)]

    def owner(virtual: str) -> MountRow | None:
        served = namespace.mounts()
        found = owner_prefix([m.prefix for m in served], virtual)
        return next((m for m in served if m.prefix == found), None)

    def is_root(virtual: str) -> bool:
        if crossing:
            return False
        return any(m.prefix == norm_dir(virtual) for m in namespace.mounts())

    def root_of(virtual: str) -> str:
        row = owner(virtual)
        return row.prefix if row is not None else "/"

    def max_du_entries(virtual: str) -> int | None:
        row = owner(virtual)
        return row.max_du_entries if row is not None else None

    def answers(virtual: str, name: str) -> bool:
        row = None if crossing else owner(virtual)
        return row is not None and name in row.calls

    def max_glob_matches(virtual: str) -> int | None:
        row = None if crossing else owner(virtual)
        return row.max_glob_matches if row is not None else None

    def searchable(virtual: str) -> tuple[str, ...] | None:
        row = None if crossing else owner(virtual)
        return row.searchable if row is not None else None

    return MountView(
        descendants=below,
        visible_descendants=visible_below,
        is_root=is_root,
        root_of=root_of,
        max_du_entries=max_du_entries,
        answers=answers,
        max_glob_matches=max_glob_matches,
        searchable=searchable,
    )


def owed_names(files: Files | None, directory: str) -> list[str]:
    """The names a directory holds only as namespace structure, as the
    session sees them: the mounts below it and its links, each by its
    first segment under the directory.

    No backend can list either, and the first may be one no backend
    serves at all (a link made below a directory chain that holds no
    key); these are the names the dispatcher merges into its own
    listing, from the same tables.

    Args:
        files (Files | None): the session's files, None outside a
            workspace.
        directory (str): the directory's virtual path.
    """
    if files is None:
        return []
    namespace = namespace_of(files)
    return namespace_names(
        namespace.vis(),
        [m.prefix for m in namespace.mounts()],
        namespace.links,
        directory,
    )


def links_of(ctx: Context) -> LinkView | None:
    """The workspace's links as the command's session sees them, read off
    its files; None outside a workspace.

    Args:
        ctx (Context): the invocation's context.
    """
    return link_view(ctx.vfs)


def crosses_mounts(ctx: Context) -> bool:
    """Whether the command walks across mounts.

    It runs on the session's files with no mount's command scope bound,
    as a cross-mount run does, so every call it makes reaches whichever
    mount serves the path.

    Args:
        ctx (Context): the invocation's context.
    """
    return ctx.vfs is not None and current_caller().mount is None


def mount_root(ctx: Context) -> str:
    """The prefix of the mount the command runs on, without its trailing
    slash: what a path the command makes up (an output name, a file a
    list names) is keyed below.

    '' for a run across mounts, which keys every path by its whole
    virtual path, and outside a workspace.

    Args:
        ctx (Context): the invocation's context.
    """
    mount = current_caller().mount if ctx.vfs is not None else None
    return mount[0].rstrip("/") if mount is not None else ""


def mounts_of(ctx: Context) -> MountView | None:
    """Where the mount boundaries are for the command's walk, read off
    its files; None outside a workspace.

    A run across mounts (``crosses_mounts``) has the dispatcher descend
    into every mount, so it has no boundary to stop at.

    Args:
        ctx (Context): the invocation's context.
    """
    return mount_view(ctx.vfs, crossing=crosses_mounts(ctx))


def visibility_of(files: Files | None) -> Visibility | None:
    """The visibility of the session the files run as, None for none.

    Args:
        files (Files | None): the session's files.
    """
    return namespace_of(files).vis() if files is not None else None


def link_resolver(ctx: Context) -> LinkResolver | None:
    """The link resolver an invocation carries: None outside a workspace.

    Args:
        ctx (Context): the invocation's context.
    """
    links = links_of(ctx)
    if links is None or ctx.vfs is None:
        return None
    return LinkResolver(
        links=links, dispatch=ctx.vfs.dispatch, cwd=ctx.cwd.virtual
    )


def dispatch_of(ctx: Context) -> DispatchFn | None:
    """The dispatcher a command's files run on; None outside a workspace.

    Args:
        ctx (Context): the invocation's context.
    """
    return ctx.vfs.dispatch if ctx.vfs is not None else None


def follow_of(ctx: Context) -> FollowOperands | None:
    """The line's operand resolution its files carry; None outside a line.

    Args:
        ctx (Context): the invocation's context.
    """
    return namespace_of(ctx.vfs).follow if ctx.vfs is not None else None


__all__ = [
    "LinkResolver",
    "crosses_mounts",
    "dispatch_of",
    "follow_of",
    "link_location",
    "link_resolver",
    "link_view",
    "mount_root",
    "mount_view",
    "links_of",
    "mounts_of",
    "name_location",
    "owed_names",
    "serves",
    "typed_link",
    "visibility_of",
]
