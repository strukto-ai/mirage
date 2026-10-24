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


from functools import partial
from typing import cast

from mirage.commands.builtin.generic_bind.files import dispatched_read_tree
from mirage.commands.builtin.utils.links import (
    link_location,
    link_view,
    mount_view,
)
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.cli.builtin.git.constants import GIT_DIR
from mirage.commands.cli.builtin.git.errors import WorkTreeLimitError
from mirage.commands.cli.builtin.git.ignore import (
    GITIGNORE,
    IgnoreStack,
    load_ignores,
)
from mirage.commands.cli.builtin.git.io import (
    read_names,
    read_optional,
)
from mirage.commands.cli.builtin.git.pathspec import under
from mirage.commands.cli.builtin.git.types import RepoLocation, WorkTree
from mirage.errors.constants import MISS_ERRORS
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.remnants import entry_name
from mirage.workspace.files import Files

# git's three untracked modes. "normal" names an untracked directory
# once instead of everything inside it, "all" names every file, and "no"
# leaves them out and is the reason the mode is threaded into the walk
# rather than filtered afterwards: not reporting them means not looking
# for them, which is the whole saving.
UNTRACKED_NO = "no"
UNTRACKED_NORMAL = "normal"
UNTRACKED_ALL = "all"


def tracked_directories(tracked: set[str]) -> set[str]:
    """Every directory that holds a tracked path, at any depth.

    Answering "does this directory contain anything tracked" per
    directory would rescan the index once per directory walked; the same
    question asked of a prepared set is a lookup.

    Args:
        tracked (set[str]): repository-relative paths the index holds.
    """
    directories: set[str] = set()
    for path in tracked:
        parts = path.split("/")[:-1]
        for depth in range(len(parts)):
            directories.add("/".join(parts[: depth + 1]))
    return directories


class Scanner:
    """One walk of the working tree, carrying what the walk needs.

    Args:
        vfs (Files): the session's files.
        worktree (PathSpec): absolute virtual path of the working tree root.
        tracked (set[str]): repository-relative paths the index holds.
        mode (str): which untracked files to report, one of
            ``UNTRACKED_NO`` / ``UNTRACKED_NORMAL`` / ``UNTRACKED_ALL``.
        roots (tuple[str, ...] | None): the repository-relative paths
            the walk is narrowed to; None for the whole tree.
    """

    def __init__(
        self,
        vfs: Files,
        worktree: PathSpec,
        tracked: set[str],
        mode: str,
        show_ignored: bool = False,
        roots: tuple[str, ...] | None = None,
    ) -> None:
        self._vfs = vfs
        self._worktree = worktree
        self._tracked = tracked
        self._directories = tracked_directories(tracked)
        self._mode = mode
        self._show_ignored = show_ignored
        self._roots = roots
        self._mounts = mount_view(vfs, crossing=True)
        self._counted: dict[str, int] = {}
        links = link_view(vfs)
        self._tree_readdir, self._tree_lstat = tree_walk(
            dispatched_read_tree(
                vfs.dispatch,
                mount_view(vfs),
                None if links is None else partial(link_location, links),
                True,
            ),
            vfs.readdir,
            partial(vfs.stat, nofollow=True),
        )
        self.found = WorkTree()

    def _absolute(self, relative: str) -> PathSpec:
        """The virtual path a repository-relative path names.

        Args:
            relative (str): repository-relative path, empty at the root.
        """
        return self._worktree.join(relative) if relative else self._worktree

    def _reaches(self, relative: str) -> bool:
        """Whether the walk goes to a path: one a root names or holds,
        or a directory above a root.

        Args:
            relative (str): repository-relative path of the entry.
        """
        return self._roots is None or any(
            relative == root or under(relative, root) or under(root, relative)
            for root in self._roots
        )

    def _count(self, relative: str) -> None:
        """Count one file against the mount serving it; a file a root
        names costs nothing, as a file handed to grep does.

        Args:
            relative (str): repository-relative path of the file.

        Raises:
            WorkTreeLimitError: the mount's ``walk_limit`` is spent.
        """
        if self._roots is not None and relative in self._roots:
            return
        if self._mounts is None or self._mounts.walk_limit is None:
            return
        virtual = self._absolute(relative).virtual
        limit = self._mounts.walk_limit(virtual)
        root = self._mounts.root_of(virtual)
        if 0 <= limit <= self._counted.get(root, 0):
            raise WorkTreeLimitError(limit)
        self._counted[root] = self._counted.get(root, 0) + 1

    def _whole(self, relative: str) -> bool:
        """Whether the walk reads a directory's whole subtree, which a
        mount's ``read_tree`` may then answer in one call: any below the
        work tree's root, whose own subtree holds the git directory the
        walk skips, at or under a root.

        Args:
            relative (str): repository-relative path of the directory.
        """
        return bool(relative) and (
            self._roots is None
            or any(
                relative == root or under(relative, root)
                for root in self._roots
            )
        )

    async def _names(self, relative: str) -> list[str]:
        """A directory's entries, empty when it does not exist.

        Args:
            relative (str): repository-relative path, empty at the root.
        """
        path = self._absolute(relative)
        if not self._whole(relative):
            return await read_names(self._vfs, path)
        try:
            return cast(list[str], await self._tree_readdir(path))
        except MISS_ERRORS:
            return []

    async def _entry_stat(self, relative: str) -> FileStat | None:
        """What the walk sees at one path, without following a link.

        Args:
            relative (str): repository-relative path of the entry.
        """
        try:
            return cast(
                FileStat, await self._tree_lstat(self._absolute(relative))
            )
        except MISS_ERRORS:
            return None

    async def _holds_a_file(
        self,
        relative: str,
        ignores: IgnoreStack,
        include_ignored: bool = False,
    ) -> bool:
        """Whether a directory holds anything git would call untracked.

        git lists a directory only when something inside it would be
        reported, so a directory holding nothing but ignored files, or
        nothing at all, is not mentioned. Stops at the first find.

        Args:
            relative (str): repository-relative path of the directory.
            ignores (IgnoreStack): the rules governing it.
        """
        rules = await self._descend(relative, ignores)
        for entry in await self._names(relative):
            name = entry_name(entry)
            if not name:
                continue
            child = f"{relative}/{name}" if relative else name
            info = await self._entry_stat(child)
            if info is None:
                continue
            directory = info.type is FileType.DIRECTORY
            if not directory:
                self._count(child)
            if not include_ignored and rules.is_ignored(child, directory):
                continue
            if not directory:
                return True
            if await self._holds_a_file(child, rules, include_ignored):
                return True
        return False

    async def _descend(
        self, relative: str, ignores: IgnoreStack
    ) -> IgnoreStack:
        """The ignore rules inside a directory, given the ones outside.

        Args:
            relative (str): repository-relative path of the directory.
            ignores (IgnoreStack): the rules governing its parent.
        """
        if not relative:
            return ignores
        local = await read_optional(
            self._vfs, self._absolute(relative).join(GITIGNORE)
        )
        return ignores if local is None else ignores.push(relative, local)

    async def _visit_directory(
        self, relative: str, ignored: bool, ignores: IgnoreStack
    ) -> None:
        """Decide what a subdirectory contributes, then walk it or not.

        An ignored directory is still walked when the index holds
        something inside it. Ignore rules govern untracked files only, so
        a tracked file under an ignored directory is still compared, and
        skipping the directory outright would report it deleted.

        Args:
            relative (str): repository-relative path of the directory.
            ignored (bool): whether an ignore rule already caught it.
            ignores (IgnoreStack): the rules governing its parent.
        """
        holds_tracked = relative in self._directories
        if ignored:
            if holds_tracked or (
                self._show_ignored and self._mode == UNTRACKED_ALL
            ):
                await self.walk(relative, True, ignores)
            elif (
                self._show_ignored
                and self._mode != UNTRACKED_NO
                and await self._holds_a_file(relative, ignores, True)
            ):
                self.found.ignored.append(f"{relative}/")
            return
        if holds_tracked or self._mode == UNTRACKED_ALL:
            await self.walk(relative, False, ignores)
            return
        if self._show_ignored and self._mode == UNTRACKED_NORMAL:
            first = len(self.found.untracked)
            ignored_first = len(self.found.ignored)
            await self.walk(relative, False, ignores)
            if len(self.found.untracked) > first:
                self.found.untracked[first:] = [f"{relative}/"]
            elif len(self.found.ignored) > ignored_first:
                self.found.ignored[ignored_first:] = [f"{relative}/"]
            return
        if self._mode == UNTRACKED_NORMAL and await self._holds_a_file(
            relative, ignores
        ):
            self.found.untracked.append(f"{relative}/")

    async def walk(
        self, relative: str, ignored: bool, ignores: IgnoreStack
    ) -> None:
        """Walk one directory, recording files and untracked entries.

        Args:
            relative (str): repository-relative path, empty at the root.
            ignored (bool): whether this directory is itself ignored, in
                which case nothing inside it is reported untracked.
            ignores (IgnoreStack): the rules governing its parent.
        """
        rules = await self._descend(relative, ignores)
        for entry in sorted(await self._names(relative)):
            name = entry_name(entry)
            if not name or (not relative and name == GIT_DIR):
                continue
            child = f"{relative}/{name}" if relative else name
            if not self._reaches(child):
                continue
            info = await self._entry_stat(child)
            if info is None:
                continue
            if info.type is FileType.DIRECTORY:
                await self._visit_directory(
                    child, ignored or rules.is_ignored(child, True), rules
                )
                continue
            self._count(child)
            self.found.files[child] = info
            if child in self._tracked or self._mode == UNTRACKED_NO:
                continue
            if not ignored and not rules.is_ignored(child, False):
                self.found.untracked.append(child)
            elif self._show_ignored:
                self.found.ignored.append(child)


async def scan(
    vfs: Files,
    location: RepoLocation,
    tracked: set[str],
    mode: str,
    show_ignored: bool = False,
    roots: tuple[str, ...] | None = None,
) -> WorkTree:
    """Walk a working tree once, for both halves of a status report.

    One walk answers two questions, which is why they are not asked
    separately: which tracked files still exist and how big they are,
    and which untracked ones git would mention. Statting each index path
    instead would miss every untracked file, and listing untracked files
    alone would leave the deletions unfound.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        tracked (set[str]): repository-relative paths the index holds.
        mode (str): which untracked files to report, one of
            ``UNTRACKED_NO`` / ``UNTRACKED_NORMAL`` / ``UNTRACKED_ALL``.
        show_ignored (bool): whether to report ignored files too.
        roots (tuple[str, ...] | None): narrow the walk to these
            repository-relative paths and what lies under them, for a
            verb whose pathspecs say what it reads; None walks it all.
    """
    ignores = await load_ignores(vfs, location.commondir, location.worktree)
    scanner = Scanner(
        vfs,
        location.worktree,
        tracked,
        mode,
        show_ignored,
        roots,
    )
    await scanner.walk("", False, ignores)
    return scanner.found
