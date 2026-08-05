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
from typing import Any, Callable

from mirage.commands.cli.builtin.git.ignore import (GITIGNORE, IgnoreStack,
                                                    load_ignores)
from mirage.commands.cli.builtin.git.io import read_names, read_optional
from mirage.commands.cli.builtin.git.types import RepoLocation, WorkTree
from mirage.ops.types import StatPath
from mirage.types import FileType

GIT_DIR = ".git"

# git's three untracked modes. "normal" names an untracked directory
# once instead of everything inside it, "all" names every file, and "no"
# leaves them out and is the reason the mode is threaded into the walk
# rather than filtered afterwards: not reporting them means not looking
# for them, which is the whole saving.
UNTRACKED_NO = "no"
UNTRACKED_NORMAL = "normal"
UNTRACKED_ALL = "all"


def _name_of(entry: str) -> str:
    """The final segment of a readdir entry.

    Args:
        entry (str): one entry as the backend reported it, which may be a
            bare name or a path and may carry a trailing slash.
    """
    return entry.rstrip("/").rsplit("/", 1)[-1]


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
            directories.add("/".join(parts[:depth + 1]))
    return directories


class Scanner:
    """One walk of the working tree, carrying what the walk needs.

    Args:
        dispatch (Callable): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        worktree (str): absolute virtual path of the working tree root.
        tracked (set[str]): repository-relative paths the index holds.
        mode (str): which untracked files to report, one of
            ``UNTRACKED_NO`` / ``UNTRACKED_NORMAL`` / ``UNTRACKED_ALL``.
    """

    def __init__(self, dispatch: Callable[..., Any], stat_path: StatPath,
                 worktree: str, tracked: set[str], mode: str) -> None:
        self._dispatch = dispatch
        self._stat_path = stat_path
        self._worktree = worktree
        self._tracked = tracked
        self._directories = tracked_directories(tracked)
        self._mode = mode
        self.found = WorkTree()

    def _absolute(self, relative: str) -> str:
        """The virtual path a repository-relative path names.

        Args:
            relative (str): repository-relative path, empty at the root.
        """
        return posixpath.join(self._worktree,
                              relative) if relative else self._worktree

    async def _holds_a_file(self, relative: str, ignores: IgnoreStack) -> bool:
        """Whether a directory holds anything git would call untracked.

        git lists a directory only when something inside it would be
        reported, so a directory holding nothing but ignored files, or
        nothing at all, is not mentioned. Stops at the first find.

        Args:
            relative (str): repository-relative path of the directory.
            ignores (IgnoreStack): the rules governing it.
        """
        rules = await self._descend(relative, ignores)
        for entry in await read_names(self._dispatch,
                                      self._absolute(relative)):
            name = _name_of(entry)
            if not name:
                continue
            child = f"{relative}/{name}" if relative else name
            info = await self._stat_path(self._absolute(child))
            if info is None:
                continue
            directory = info.type is FileType.DIRECTORY
            if rules.is_ignored(child, directory):
                continue
            if not directory:
                return True
            if await self._holds_a_file(child, rules):
                return True
        return False

    async def _descend(self, relative: str,
                       ignores: IgnoreStack) -> IgnoreStack:
        """The ignore rules inside a directory, given the ones outside.

        Args:
            relative (str): repository-relative path of the directory.
            ignores (IgnoreStack): the rules governing its parent.
        """
        if not relative:
            return ignores
        local = await read_optional(
            self._dispatch, posixpath.join(self._absolute(relative),
                                           GITIGNORE))
        return ignores if local is None else ignores.push(relative, local)

    async def _visit_directory(self, relative: str, ignored: bool,
                               ignores: IgnoreStack) -> None:
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
            if holds_tracked:
                await self.walk(relative, True, ignores)
            return
        if holds_tracked or self._mode == UNTRACKED_ALL:
            await self.walk(relative, False, ignores)
            return
        if self._mode == UNTRACKED_NORMAL and await self._holds_a_file(
                relative, ignores):
            self.found.untracked.append(f"{relative}/")

    async def walk(self, relative: str, ignored: bool,
                   ignores: IgnoreStack) -> None:
        """Walk one directory, recording files and untracked entries.

        Args:
            relative (str): repository-relative path, empty at the root.
            ignored (bool): whether this directory is itself ignored, in
                which case nothing inside it is reported untracked.
            ignores (IgnoreStack): the rules governing its parent.
        """
        rules = await self._descend(relative, ignores)
        for entry in sorted(await read_names(self._dispatch,
                                             self._absolute(relative))):
            name = _name_of(entry)
            if not name or (not relative and name == GIT_DIR):
                continue
            child = f"{relative}/{name}" if relative else name
            info = await self._stat_path(self._absolute(child))
            if info is None:
                continue
            if info.type is FileType.DIRECTORY:
                await self._visit_directory(
                    child, ignored or rules.is_ignored(child, True), rules)
                continue
            self.found.files[child] = info
            if child in self._tracked or self._mode == UNTRACKED_NO:
                continue
            if not ignored and not rules.is_ignored(child, False):
                self.found.untracked.append(child)


async def scan(dispatch: Callable[..., Any], stat_path: StatPath,
               location: RepoLocation, tracked: set[str],
               mode: str) -> WorkTree:
    """Walk a working tree once, for both halves of a status report.

    One walk answers two questions, which is why they are not asked
    separately: which tracked files still exist and how big they are,
    and which untracked ones git would mention. Statting each index path
    instead would miss every untracked file, and listing untracked files
    alone would leave the deletions unfound.

    Args:
        dispatch (Callable): workspace op dispatcher.
        stat_path (StatPath): dispatcher-backed stat, both channels.
        location (RepoLocation): the discovered repository.
        tracked (set[str]): repository-relative paths the index holds.
        mode (str): which untracked files to report, one of
            ``UNTRACKED_NO`` / ``UNTRACKED_NORMAL`` / ``UNTRACKED_ALL``.
    """
    ignores = await load_ignores(dispatch, location.gitdir, location.worktree)
    scanner = Scanner(dispatch, stat_path, location.worktree, tracked, mode)
    await scanner.walk("", False, ignores)
    return scanner.found
