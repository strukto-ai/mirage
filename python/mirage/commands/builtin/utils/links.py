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

from collections.abc import AsyncIterator
from dataclasses import dataclass

from mirage.commands.config import CommandOpts
from mirage.errors.fs import eloop
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, PathSpec
from mirage.utils.path import CycleError, resolve_path
from mirage.view.types import LinkView


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
    parent, _, name = resolve_path(typed, cwd).rpartition("/")
    return f"{links.resolve(parent or '/').rstrip('/')}/{name}"


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

    def children(self, directory: str) -> list[str]:
        """The links standing directly in a directory, as virtual paths.

        What a walker merges into a backend's listing, which never holds
        a link.

        Args:
            directory (str): the directory's virtual path, every link
                above it resolved, which is how the table keys its links.
        """
        base = directory.rstrip("/")
        return [f"{base}/{row.name}" for row in self.links.children(directory)]

    def target(self, link: str) -> str:
        """Where a link leads, every link on the way followed.

        Args:
            link (str): the link's virtual path.

        Raises:
            DotWalkLoop: the chain loops (ELOOP), an OSError a walker
                reports as it reports any failed stat.
        """
        try:
            return self.links.resolve(link)
        except CycleError:
            raise eloop(link) from None

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


__all__ = ["LinkResolver", "link_resolver", "name_location", "typed_link"]
