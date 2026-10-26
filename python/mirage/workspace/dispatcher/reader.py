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

import posixpath
from collections.abc import Callable, Mapping

from mirage.context.session_context import current_caller
from mirage.policy.builtin.output_cap import walk_bound
from mirage.types import FileStat, Limit, PathSpec, Visibility
from mirage.utils.hidden import hidden_under, leads_hidden, path_visible
from mirage.utils.path import norm, norm_dir, owner_prefix
from mirage.view.namespace_view import namespace_names
from mirage.view.types import MountView, NamespaceLinks
from mirage.workspace.types import MountRow


def sees(
    vis: Visibility | None, links: NamespaceLinks | None, virtual: str
) -> bool:
    """Whether a session sees a path: it is not hidden, and no link on
    it leads where the session cannot see.

    The rule the dispatcher refuses a call by, and the one every answer
    a ``NamespaceReader`` gives is filtered by.

    Args:
        vis (Visibility | None): the session's visibility.
        links (NamespaceLinks | None): the namespace's link table.
        virtual (str): absolute virtual path.
    """
    if not path_visible(vis, virtual):
        return False
    if vis is None or links is None:
        return True
    return not leads_hidden(vis, virtual, links.symlink_targets())


class NamespaceReader:
    """What one session sees of the namespace: its links and its mounts.

    The namespace the dispatcher answers from owns the link table and
    the mount table and hands this out (``Namespace.readers``); it is
    the one way anything above the dispatcher reads them. Every answer
    is filtered by the rule the dispatcher refuses a call by (``sees``):
    a hidden link, or one that leads where the session cannot see, has
    no row, no listing entry and no target, and a hidden mount is a
    boundary a walk stops at but is never named. It is a link table
    itself (``NamespaceLinks``), the namespace's as the session sees it,
    so whatever takes a link table above the dispatcher is handed this
    one. Live, so a link made or removed mid-command is seen by the next
    question, and synchronous, so a walk asks per entry at no dispatch
    cost.

    Args:
        links (NamespaceLinks | None): the namespace's link table, None
            where the files stand outside a workspace.
        rows (Callable[[], list[MountRow]]): every registered mount.
        session_id (str | None): the session the answers are for, which
            decides the mounts it is told of at all.
        visibility (Callable[[], Visibility | None]): the visibility of
            that session, asked when a question is.
    """

    def __init__(
        self,
        links: NamespaceLinks | None,
        rows: Callable[[], list[MountRow]],
        session_id: str | None,
        visibility: Callable[[], Visibility | None],
    ) -> None:
        self._links = links
        self._rows = rows
        self._session_id = session_id
        self._visibility = visibility

    @property
    def linked(self) -> bool:
        """Whether a link table stands behind the answers."""
        return self._links is not None

    def visible(self, path: str | PathSpec) -> bool:
        """Whether the session sees ``path`` (``sees``).

        Args:
            path (str | PathSpec): virtual path.
        """
        virtual = PathSpec.from_str_path(path, cwd="/").virtual
        return sees(self._visibility(), self._links, virtual)

    def hides_under(self, path: str | PathSpec) -> bool:
        """Whether the session could hide anything at or under ``path``,
        so a reader of a store of its own (a repository's history, say)
        has to ask ``visible`` of what it finds there.

        Args:
            path (str | PathSpec): virtual path.
        """
        virtual = PathSpec.from_str_path(path, cwd="/").virtual
        vis = self._visibility()
        if hidden_under(vis, virtual):
            return True
        if self._links is None or not hidden_under(vis, "/"):
            return False
        # ``visible`` follows links, so a link at, under or above the
        # path can lead where the session hides even when nothing named
        # under the path is hidden.
        return any(
            link == virtual
            or link.startswith(virtual.rstrip("/") + "/")
            or virtual.startswith(link.rstrip("/") + "/")
            for link in self._links.symlink_targets()
        )

    def rows(self) -> list[MountRow]:
        """Every registered mount, hides and sessions aside: what the
        host asks of the mount table (FUSE, the runtime's open)."""
        return sorted(self._rows(), key=lambda m: len(m.prefix), reverse=True)

    def owner(self, path: str) -> MountRow | None:
        """The registered mount owning ``path`` by longest prefix.

        Args:
            path (str): absolute virtual path.
        """
        rows = self.rows()
        found = owner_prefix((m.prefix for m in rows), path)
        return next((m for m in rows if m.prefix == found), None)

    def served(self) -> list[MountRow]:
        """The mounts the session is told of at all, hides aside.

        A session's own documents mount is one only it is told of.
        """
        return [
            m
            for m in self.rows()
            if m.visible is None or m.visible(self._session_id)
        ]

    def shown(self) -> list[MountRow]:
        """The mounts whose root the session sees.

        A hidden mount is left out of every list here, as it is left out
        of a listing, so no list names it.
        """
        vis = self._visibility()
        return [m for m in self.served() if path_visible(vis, norm(m.prefix))]

    def mount_of(self, path: str | PathSpec) -> str | None:
        """The prefix of the mount serving ``path``, without a trailing
        slash; None for a path the session cannot see.

        Args:
            path (str | PathSpec): virtual path.
        """
        virtual = PathSpec.from_str_path(path, cwd="/").virtual
        if not path_visible(self._visibility(), virtual):
            return None
        owner = owner_prefix((m.prefix for m in self.served()), virtual)
        return None if owner is None else norm(owner)

    def is_mount(self, path: str | PathSpec) -> bool:
        """Whether ``path`` is the root of a mount the session sees.

        Args:
            path (str | PathSpec): virtual path.
        """
        virtual = norm(PathSpec.from_str_path(path, cwd="/").virtual)
        return any(norm(m.prefix) == virtual for m in self.shown())

    def submounts(self, path: str | PathSpec) -> list[str]:
        """The mount roots strictly under ``path``, sorted, without a
        trailing slash; a hidden one reported by the nearest folder
        above it the session sees.

        Args:
            path (str | PathSpec): virtual directory path.
        """
        virtual = norm(PathSpec.from_str_path(path, cwd="/").virtual)
        vis = self._visibility()
        if not path_visible(vis, virtual):
            return []
        below = norm_dir(virtual)
        found: set[str] = set()
        for m in self.served():
            root = norm(m.prefix)
            if root == virtual or not norm_dir(root).startswith(below):
                continue
            while root != virtual and not path_visible(vis, root):
                root = posixpath.dirname(root)
            found.add(root)
        return sorted(found)

    def is_link(self, path: str) -> bool:
        """Whether a link the session sees stands at ``path``.

        Args:
            path (str): absolute virtual path.
        """
        return (
            self._links is not None
            and self.visible(path)
            and self._links.is_link(path)
        )

    def link_stat_at(self, path: str) -> FileStat | None:
        """The link standing at a path, its own row; None where none
        stands or the session cannot see it.

        Args:
            path (str): absolute virtual path.
        """
        if self._links is None or not self.visible(path):
            return None
        return self._links.link_stat_at(path)

    def symlink_targets(self) -> Mapping[str, str]:
        """Every link the session sees, to its stored target."""
        if self._links is None:
            return {}
        targets = self._links.symlink_targets()
        vis = self._visibility()
        # A session that hides nothing sees every link; asking each one
        # walks its whole chain, on every command that checks for links.
        if not hidden_under(vis, "/"):
            return targets
        return {p: t for p, t in targets.items() if self.visible(p)}

    def link_stats_below(self, directory: str) -> list[tuple[str, FileStat]]:
        """The links at any depth under a directory the session sees,
        each with its own row.

        Args:
            directory (str): absolute virtual directory path.
        """
        if self._links is None:
            return []
        return [
            (path, row)
            for path, row in self._links.link_stats_below(directory)
            if self.visible(path)
        ]

    def link_names_under(self, directory: str) -> set[str]:
        """The names of the links directly under a directory that the
        session sees, which a listing's link marks need.

        Args:
            directory (str): absolute virtual directory path.
        """
        if self._links is None:
            return set()
        return {
            name
            for name in self._links.link_names_under(directory)
            if self.visible(posixpath.join(directory, name))
        }

    def readlink(self, path: str) -> str | None:
        """A link's stored target, as typed; None where no link stands
        or the session cannot see it.

        Args:
            path (str): absolute virtual path.
        """
        if self._links is None or not self.visible(path):
            return None
        return self._links.readlink(path)

    def follow(self, path: str) -> str:
        """Where a path the session sees leads, every link followed; one
        it cannot see, a link on it leading through a hide included, is
        left as typed, for the dispatcher to refuse.

        Args:
            path (str): absolute virtual path.

        Raises:
            CycleError: a link loop stands in the walk.
        """
        if self._links is None or not self.visible(path):
            return path
        return self._links.follow(path)

    def follow_parent(self, path: str) -> str:
        """A path with every link above its final name followed, the
        walk a call that acts on the name itself is given; a path the
        session cannot see is left as typed.

        Args:
            path (str): absolute virtual path.

        Raises:
            CycleError: a link loop stands in the walk.
        """
        if self._links is None or not self.visible(path):
            return path
        return self._links.follow_parent(path)

    def owed(self, directory: str) -> list[str]:
        """The names a directory holds only as namespace structure: the
        mounts below it and its links, by their first segment under it.

        Args:
            directory (str): absolute virtual directory path.
        """
        return namespace_names(
            self._visibility(),
            [m.prefix for m in self.served()],
            self._links,
            directory,
        )

    def mounts(
        self,
        crossing: bool,
        command: str | None = None,
        profile: Mapping[str, Limit] | None = None,
    ) -> MountView:
        """Where the mount boundaries are, as the session sees them.

        Every mount below a path, hidden or not, is a boundary a
        backend's own walk stops at: a mount the session cannot see
        still shadows the parent backend's keys under its prefix. Only
        the visible ones are ever named. A walk through the dispatcher
        (``crossing``) descends into each mount itself, so it has no
        boundary to stop at: no mount below a path, and no mount root;
        and it takes no mount's shortcut, so no mount answers a function
        for it or narrows its search.

        A walk's ``walk_limit`` on each mount is ``command``'s
        (``walk_bound``), resolved through the session's ``profile``, the
        mount's and the workspace's command limits and the running
        command's declared one; without a command, the one every command
        shares. Both default to the running command's and its session's.

        Args:
            crossing (bool): the walk goes through the dispatcher.
            command (str | None): the command walking.
            profile (Mapping[str, Limit] | None): the session profile's
                command limits.
        """
        caller = current_caller()
        declared = (
            caller.declared if command in (None, caller.command) else None
        )
        if command is None:
            command = caller.command
        if profile is None and caller.session is not None:
            profile = caller.session.command_limits

        def below(virtual: str) -> list[str]:
            if crossing:
                return []
            base = norm_dir(virtual)
            return [
                m.prefix.rstrip("/") or "/"
                for m in sorted(self.served(), key=lambda m: m.prefix)
                if m.prefix != base and m.prefix.startswith(base)
            ]

        def visible_below(virtual: str) -> list[str]:
            vis = self._visibility()
            return [root for root in below(virtual) if path_visible(vis, root)]

        def owner(virtual: str) -> MountRow | None:
            served = self.served()
            found = owner_prefix([m.prefix for m in served], virtual)
            return next((m for m in served if m.prefix == found), None)

        def is_root(virtual: str) -> bool:
            if crossing:
                return False
            return any(m.prefix == norm_dir(virtual) for m in self.served())

        def root_of(virtual: str) -> str:
            row = owner(virtual)
            return row.prefix if row is not None else "/"

        def answers(virtual: str, name: str) -> bool:
            row = None if crossing else owner(virtual)
            return row is not None and name in row.calls

        def searchable(virtual: str) -> tuple[str, ...] | None:
            row = None if crossing else owner(virtual)
            return row.searchable if row is not None else None

        def walk_limit(virtual: str) -> int:
            row = owner(virtual)
            if row is None:
                return -1
            return walk_bound(
                row, command, declared, row.workspace_limits, profile
            )

        return MountView(
            descendants=below,
            visible_descendants=visible_below,
            is_root=is_root,
            root_of=root_of,
            answers=answers,
            searchable=searchable,
            walk_limit=walk_limit,
        )
