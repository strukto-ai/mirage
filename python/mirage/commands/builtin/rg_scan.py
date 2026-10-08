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
from collections.abc import AsyncIterator
from dataclasses import dataclass

from mirage.commands.builtin.constants import BINARY_EXTENSIONS
from mirage.commands.builtin.rg_filetypes import FileTypes
from mirage.commands.builtin.rg_glob import Overrides, Verdict, walk_candidate
from mirage.commands.builtin.utils.links import LinkDoor
from mirage.commands.builtin.utils.types import AsyncReaddirFn, AsyncStatFn
from mirage.commands.resolve import get_extension
from mirage.doors.types import MountIsRoot, MountRoot
from mirage.errors.classify import classify
from mirage.errors.constants import WALK_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import linux_errno
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import respell_one


def os_error_text(exc: BaseException) -> str:
    """An OS error the way ripgrep's Rust ``io::Error`` displays it.

    The strerror, then the Linux errno it came from: ``No such file or
    directory (os error 2)``. A failure the vocabulary cannot number keeps
    its words alone.

    Args:
        exc (BaseException): the failure.
    """
    text = fs_strerror(exc) or str(exc)
    condition = classify(exc)
    if condition is None:
        return text
    return f"{text} (os error {linux_errno(condition)})"


def walk_error_line(
    shown: str, exc: BaseException, parallel: bool = False
) -> str:
    """ripgrep's line for a path its walker could not stat or list.

    ripgrep words it by the walker it ran. The sequential one names the
    path a second time: ``rg: nope: IO error for operation on nope: No
    such file or directory (os error 2)``; the parallel one, which it
    runs for more than one path or a directory unless ``-j1`` or a sort
    holds it to one thread, names it once: ``rg: nope: No such file or
    directory (os error 2)`` (ripgrep 14.1.1).

    Args:
        shown (str): the path as ripgrep names it.
        exc (BaseException): the failure.
        parallel (bool): ripgrep would walk with its parallel walker.
    """
    if parallel:
        return f"rg: {shown}: {os_error_text(exc)}"
    return (
        f"rg: {shown}: IO error for operation on {shown}: {os_error_text(exc)}"
    )


def loop_error_line(shown: str, ancestor: str) -> str:
    """ripgrep's line for a link -L found leading back into the walk.

    ``rg: File system loop found: s/sub/up points to an ancestor s``: the
    link, then the directory above it that it names, nearest first, each
    as the walker spells it (ripgrep 14.1.1).

    Args:
        shown (str): the link as the walker names it.
        ancestor (str): the directory it leads back to, named the same way.
    """
    return (
        f"rg: File system loop found: {shown} points to an ancestor {ancestor}"
    )


def open_error_line(shown: str, exc: BaseException) -> str:
    """ripgrep's line for a file its searcher could not open or read.

    The bare I/O error, without the walker's preamble: ``rg: locked.txt:
    Permission denied (os error 13)`` (ripgrep 14.1.1).

    Args:
        shown (str): the path as ripgrep names it.
        exc (BaseException): the failure.
    """
    return f"rg: {shown}: {os_error_text(exc)}"


@dataclass(frozen=True, slots=True)
class WalkFilter:
    """What ripgrep's walker keeps below a directory operand.

    The ignore crate's order: a ``-g`` glob decides first and outranks
    everything after it, then ``-t``/``-T``, and a dot entry is left out
    unless a glob or a ``-t`` type kept it or ``--hidden`` is on. A file
    is also left out past ``--max-filesize``, and for a binary extension
    unless ``-a``/``--binary`` asked for it. A name on the line is never
    filtered: only walked entries are.

    Args:
        overrides (Overrides): -g and --iglob.
        types (FileTypes): -t and -T.
        hidden (bool): --hidden.
        max_depth (int | None): -d, the deepest entry kept (1 is the
            operand's own children).
        max_filesize (int | None): --max-filesize, in bytes.
        binary (bool): keep binary-extension files.
    """

    overrides: Overrides
    types: FileTypes
    hidden: bool
    max_depth: int | None
    max_filesize: int | None
    binary: bool

    def admits(self, candidate: str, name: str, is_dir: bool) -> bool:
        """Whether a walked entry is kept (a directory: descended).

        Args:
            candidate (str): the entry's path as the globs match it.
            name (str): the entry's file name.
            is_dir (bool): whether it is a directory.
        """
        verdict = self.overrides.verdict(candidate, is_dir)
        if verdict is Verdict.IGNORE:
            return False
        if verdict is Verdict.WHITELIST:
            return True
        typed = self.types.verdict(name, is_dir)
        if typed is Verdict.IGNORE:
            return False
        return (
            typed is Verdict.WHITELIST
            or self.hidden
            or not name.startswith(".")
        )

    def admits_file(
        self, candidate: str, name: str, stat: FileStat | None
    ) -> bool:
        """Whether a walked file is searched.

        Args:
            candidate (str): the file's path as the globs match it.
            name (str): the file's name.
            stat (FileStat | None): its stat, when the walk has one.
        """
        if not self.admits(candidate, name, False):
            return False
        size = stat.size if stat is not None else None
        if (
            self.max_filesize is not None
            and size is not None
            and size > self.max_filesize
        ):
            return False
        return self.binary or get_extension(name) not in BINARY_EXTENSIONS


@dataclass(frozen=True, slots=True)
class Haystack:
    """One input rg searches.

    Args:
        virtual (str): its virtual path, ``-`` for stdin.
        shown (str): the path rg prints for it.
        stat (FileStat | None): its stat, when the walk read one (the time
            sorts read it).
        spec (PathSpec | None): the operand itself when it was named on
            the line, which a stream read takes.
        door (LinkDoor | None): the door a file the walk reached through a
            link is read through, since the link may lead onto a mount
            the operand's backend cannot read.
    """

    virtual: str
    shown: str
    stat: FileStat | None = None
    spec: PathSpec | None = None
    door: LinkDoor | None = None


def _entry_name(entry: str) -> str:
    """An entry's path without the folder mark some backends append.

    Args:
        entry (str): a readdir entry.
    """
    return entry.rstrip("/")


def on_other_mount(root_of: MountRoot, home: str, path: str) -> bool:
    """Whether a directory lies on another mount than the operand's.

    --one-file-system's test: a mount is mirage's filesystem boundary,
    which a directory crosses by being a mount root and a link by leading
    onto another mount.

    Args:
        root_of (MountRoot): the mount serving a path.
        home (str): the mount serving the operand.
        path (str): the directory's virtual path, every link resolved.
    """
    return root_of(path) != home


async def walk_haystacks(
    readdir_fn: AsyncReaddirFn,
    stat_fn: AsyncStatFn,
    root: str,
    shown_root: str,
    cwd: str,
    walk: WalkFilter,
    sort_by_name: bool,
    warnings: list[str] | None,
    boundary: MountIsRoot | None = None,
    door: LinkDoor | None = None,
    follow: bool = False,
    parallel: bool = False,
) -> AsyncIterator[Haystack]:
    """The files a walk of one directory operand searches, in walk order.

    A link the walk meets is skipped, as ripgrep skips one, unless
    ``follow`` (-L) says to walk through it: then it stands for what it
    leads to, a directory descended and a file searched under the link's
    own name, and one that dangles, loops or leads back to a directory
    above it is reported in ripgrep's words and skipped.

    Args:
        readdir_fn (AsyncReaddirFn): directory reader.
        stat_fn (AsyncStatFn): stat reader.
        root (str): the operand's virtual path.
        shown_root (str): the operand as typed, which every printed path
            below it starts with; empty for the implicit cwd, whose
            matches print bare while the walker names ``./x``.
        cwd (str): the session's working directory, the root the globs
            are matched from.
        walk (WalkFilter): what the walk keeps.
        sort_by_name (bool): --sort path, each directory's entries in name
            order rather than the backend's.
        warnings (list[str] | None): collects what could not be read.
        boundary (MountIsRoot | None): --one-file-system's test for a
            directory on another mount than the operand's, which the walk
            does not enter; None to enter everything.
        door (LinkDoor | None): the namespace's links and the door past
            them, None outside a workspace, where no link can stand.
        follow (bool): -L, walk through a link rather than skip it.
        parallel (bool): ripgrep would walk with its parallel walker,
            which words a failure without repeating the path.
    """
    walker = _Walker(
        readdir_fn,
        stat_fn,
        cwd,
        walk,
        sort_by_name,
        warnings,
        boundary,
        door,
        follow,
        shown_root == "",
        parallel,
    )
    top = walker.named(shown_root)
    async for found in walker.below(
        root, root, shown_root, 0, ((root, top),), False
    ):
        yield found


@dataclass(frozen=True, slots=True)
class _Walker:
    """What one operand's walk reads with and keeps, for every level.

    Args:
        readdir_fn (AsyncReaddirFn): the operand's directory reader.
        stat_fn (AsyncStatFn): the operand's stat reader.
        cwd (str): the root the globs are matched from.
        walk (WalkFilter): what the walk keeps.
        sort_by_name (bool): each directory's entries in name order.
        warnings (list[str] | None): collects what could not be read.
        boundary (MountIsRoot | None): --one-file-system's mount test.
        door (LinkDoor | None): the namespace's links and the door.
        follow (bool): -L.
        implicit (bool): the operand is the implicit cwd.
        parallel (bool): ripgrep would walk with its parallel walker.
    """

    readdir_fn: AsyncReaddirFn
    stat_fn: AsyncStatFn
    cwd: str
    walk: WalkFilter
    sort_by_name: bool
    warnings: list[str] | None
    boundary: MountIsRoot | None
    door: LinkDoor | None
    follow: bool
    implicit: bool
    parallel: bool

    def named(self, shown: str) -> str:
        """A path as the walker names it in a warning.

        Matches print the implicit cwd's paths bare, but the walker's own
        errors name the path it walked, which starts ``./`` (ripgrep
        14.1.1).

        Args:
            shown (str): the path as a match prints it.
        """
        if not self.implicit:
            return shown
        return f"./{shown}" if shown else "./"

    def warn(self, line: str) -> None:
        """Record one warning, where the caller collects them.

        Args:
            line (str): ripgrep's line.
        """
        if self.warnings is not None:
            self.warnings.append(line)

    def is_link(self, virtual: str) -> bool:
        """Whether a link stands at a walked entry.

        Args:
            virtual (str): the entry's virtual path.
        """
        return (
            self.door is not None
            and self.door.links.stat_at(virtual) is not None
        )

    async def below(
        self,
        here: str,
        base: str,
        shown_base: str,
        depth: int,
        chain: tuple[tuple[str, str], ...],
        linked: bool,
    ) -> AsyncIterator[Haystack]:
        """The files under one directory the walk lists.

        Args:
            here (str): the directory's virtual path, every link resolved.
            base (str): the path its entries are spelled from: the
                operand, or the link-resolved directory the walk last
                reached through a link.
            shown_base (str): ``base`` as printed: the operand as typed,
                or that link's printed path.
            depth (int): how deep ``here`` is below the operand.
            chain (tuple[tuple[str, str], ...]): ``here`` and every
                directory above it to the operand, nearest first, as its
                resolved path and the walker's name for it: what a link
                leading back into the walk is caught against.
            linked (bool): reached through a link, so read through the
                door rather than the operand's backend.
        """
        if self.walk.max_depth is not None and depth >= self.walk.max_depth:
            return
        door = self.door if linked else None
        try:
            if door is not None:
                entries = await door.readdir(here)
            else:
                entries = await self.readdir_fn(here)
        except WALK_ERRORS as exc:
            self.warn(walk_error_line(chain[0][1], exc, self.parallel))
            return
        if self.follow and self.door is not None:
            listed = {_entry_name(entry) for entry in entries}
            entries = [
                *entries,
                *(
                    link
                    for link in self.door.children(here)
                    if link not in listed
                ),
            ]
        if self.sort_by_name:
            entries = sorted(entries, key=_entry_name)
        for entry in entries:
            # box/dropbox readdir marks folders with a trailing slash.
            child = entry.rstrip("/") or entry
            shown = respell_one(child, base, shown_base)
            if self.is_link(child):
                if self.follow:
                    async for found in self.through(
                        child, shown, depth, chain
                    ):
                        yield found
                continue
            try:
                if door is not None:
                    s = await door.stat(entry)
                else:
                    s = await self.stat_fn(entry)
            except WALK_ERRORS as exc:
                self.warn(
                    walk_error_line(self.named(shown), exc, self.parallel)
                )
                continue
            name = posixpath.basename(child)
            candidate = walk_candidate(shown, self.cwd)
            if s.type == FileType.DIRECTORY:
                if self.boundary is not None and self.boundary(child):
                    continue
                if self.walk.admits(candidate, name, True):
                    async for found in self.below(
                        child,
                        base,
                        shown_base,
                        depth + 1,
                        ((child, self.named(shown)), *chain),
                        linked,
                    ):
                        yield found
            elif s.type is FileType.FILE and self.walk.admits_file(
                candidate, name, s
            ):
                yield Haystack(child, shown, s, door=door)

    async def through(
        self,
        link: str,
        shown: str,
        depth: int,
        chain: tuple[tuple[str, str], ...],
    ) -> AsyncIterator[Haystack]:
        """What -L walks in place of one link.

        The ignore crate's order: the link is followed first, so one that
        dangles or loops is reported whatever the filters would have said
        of its name, then a directory it leads to is checked against the
        chain above it, and only then do the filters decide.

        Args:
            link (str): the link's virtual path.
            shown (str): the link as printed.
            depth (int): how deep the directory holding it is.
            chain (tuple[tuple[str, str], ...]): that directory and
                every one above it, nearest first.
        """
        door = self.door
        if door is None:
            return
        named = self.named(shown)
        try:
            target = door.target(link)
            s = await door.stat(target)
        except WALK_ERRORS as exc:
            self.warn(walk_error_line(named, exc, self.parallel))
            return
        name = posixpath.basename(link)
        candidate = walk_candidate(shown, self.cwd)
        if s.type == FileType.DIRECTORY:
            for above, spelled in chain:
                if above == target:
                    self.warn(loop_error_line(named, spelled))
                    return
            if self.boundary is not None and self.boundary(target):
                return
            if self.walk.admits(candidate, name, True):
                async for found in self.below(
                    target,
                    target,
                    shown,
                    depth + 1,
                    ((target, named), *chain),
                    True,
                ):
                    yield found
        elif s.type is FileType.FILE and self.walk.admits_file(
            candidate, name, s
        ):
            yield Haystack(target, shown, s, door=door)


def walk_candidates(
    candidates: list[PathSpec],
    scopes: list[PathSpec],
    walk: WalkFilter,
    cwd: str,
) -> list[PathSpec]:
    """The candidates a walk of ``scopes`` would have searched.

    A search push-down narrows a directory search to candidate files and
    hands them on as operands of their own, which ripgrep never filters,
    so the walk's filters are applied here instead, to each directory on
    the way down (a directory the walk would not descend hides everything
    below it) and to the file itself, and -d counts the depth below the
    candidate's (longest-matching) scope.

    Args:
        candidates (list[PathSpec]): the narrowed candidate files.
        scopes (list[PathSpec]): the operands the search narrowed.
        walk (WalkFilter): what the walk keeps.
        cwd (str): the session's working directory.
    """
    kept: list[PathSpec] = []
    for p in candidates:
        base = ""
        raw = ""
        best = -1
        for scope in scopes:
            root = scope.virtual.rstrip("/")
            if len(root) > best and (
                p.virtual == root or p.virtual.startswith(root + "/")
            ):
                base, raw, best = root, scope.raw_path, len(root)
        if best < 0 or p.virtual == base:
            kept.append(p)
            continue
        segments = p.virtual[len(base) + 1 :].split("/")
        if walk.max_depth is not None and len(segments) > walk.max_depth:
            continue
        admitted = True
        for i, segment in enumerate(segments[:-1]):
            below = base + "/" + "/".join(segments[: i + 1])
            shown = respell_one(below, base, raw)
            if not walk.admits(walk_candidate(shown, cwd), segment, True):
                admitted = False
                break
        shown = respell_one(p.virtual, base, raw)
        if admitted and walk.admits_file(
            walk_candidate(shown, cwd), segments[-1], None
        ):
            kept.append(p)
    return kept
