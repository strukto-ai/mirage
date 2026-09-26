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
from mirage.commands.builtin.utils.types import AsyncReaddir, AsyncStat
from mirage.commands.resolve import get_extension
from mirage.ops.types import MountIsRoot
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import WALK_ERRORS, fs_strerror
from mirage.utils.path import respell_one


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
        return (typed is Verdict.WHITELIST or self.hidden
                or not name.startswith("."))

    def admits_file(self, candidate: str, name: str,
                    stat: FileStat | None) -> bool:
        """Whether a walked file is searched.

        Args:
            candidate (str): the file's path as the globs match it.
            name (str): the file's name.
            stat (FileStat | None): its stat, when the walk has one.
        """
        if not self.admits(candidate, name, False):
            return False
        size = stat.size if stat is not None else None
        if (self.max_filesize is not None and size is not None
                and size > self.max_filesize):
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
    """

    virtual: str
    shown: str
    stat: FileStat | None = None
    spec: PathSpec | None = None


def _entry_name(entry: str) -> str:
    """An entry's path without the folder mark some backends append.

    Args:
        entry (str): a readdir entry.
    """
    return entry.rstrip("/")


async def walk_haystacks(
        readdir_fn: AsyncReaddir,
        stat_fn: AsyncStat,
        root: str,
        shown_root: str,
        cwd: str,
        walk: WalkFilter,
        sort_by_name: bool,
        warnings: list[str] | None,
        boundary: MountIsRoot | None = None,
        depth: int = 0,
        directory: str | None = None) -> AsyncIterator[Haystack]:
    """The files a walk of one directory operand searches, in walk order.

    Args:
        readdir_fn (AsyncReaddir): directory reader.
        stat_fn (AsyncStat): stat reader.
        root (str): the operand's virtual path.
        shown_root (str): the operand as typed, which every printed path
            below it starts with.
        cwd (str): the session's working directory, the root the globs
            are matched from.
        walk (WalkFilter): what the walk keeps.
        sort_by_name (bool): --sort path, each directory's entries in name
            order rather than the backend's.
        warnings (list[str] | None): collects what could not be read.
        boundary (MountIsRoot | None): --one-file-system's test for a
            mount root, which the walk does not enter; None to enter
            everything the backend lists.
        depth (int): how deep ``directory`` is below the operand.
        directory (str | None): the directory to list, the operand itself
            when None.
    """
    here = root if directory is None else directory
    if walk.max_depth is not None and depth >= walk.max_depth:
        return
    try:
        entries = await readdir_fn(here)
    except WALK_ERRORS as exc:
        if warnings is not None:
            shown = respell_one(here, root, shown_root)
            warnings.append(f"rg: {shown}: {fs_strerror(exc) or exc}")
        return
    if sort_by_name:
        entries = sorted(entries, key=_entry_name)
    for entry in entries:
        # box/dropbox readdir marks folders with a trailing slash.
        child = entry.rstrip("/") or entry
        shown = respell_one(child, root, shown_root)
        try:
            s = await stat_fn(entry)
        except WALK_ERRORS as exc:
            if warnings is not None:
                warnings.append(f"rg: {shown}: {fs_strerror(exc) or exc}")
            continue
        name = posixpath.basename(child)
        candidate = walk_candidate(shown, cwd)
        if s.type == FileType.DIRECTORY:
            if boundary is not None and boundary(child):
                continue
            if walk.admits(candidate, name, True):
                async for found in walk_haystacks(readdir_fn, stat_fn, root,
                                                  shown_root, cwd, walk,
                                                  sort_by_name, warnings,
                                                  boundary, depth + 1, child):
                    yield found
        elif s.type is FileType.FILE and walk.admits_file(candidate, name, s):
            yield Haystack(child, shown, s)


def walk_candidates(candidates: list[PathSpec], scopes: list[PathSpec],
                    walk: WalkFilter, cwd: str) -> list[PathSpec]:
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
            if len(root) > best and (p.virtual == root
                                     or p.virtual.startswith(root + "/")):
                base, raw, best = root, scope.raw_path, len(root)
        if best < 0 or p.virtual == base:
            kept.append(p)
            continue
        segments = p.virtual[len(base) + 1:].split("/")
        if walk.max_depth is not None and len(segments) > walk.max_depth:
            continue
        admitted = True
        for i, segment in enumerate(segments[:-1]):
            below = base + "/" + "/".join(segments[:i + 1])
            shown = respell_one(below, base, raw)
            if not walk.admits(walk_candidate(shown, cwd), segment, True):
                admitted = False
                break
        shown = respell_one(p.virtual, base, raw)
        if admitted and walk.admits_file(walk_candidate(shown, cwd),
                                         segments[-1], None):
            kept.append(p)
    return kept
