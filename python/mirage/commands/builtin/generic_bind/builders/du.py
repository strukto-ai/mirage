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

from dataclasses import dataclass, field, replace

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.du import DuEntries, du_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    CommandFiles,
    command_files,
)
from mirage.commands.builtin.utils.links import (
    links_of,
    mount_view,
    mounts_of,
)
from mirage.commands.builtin.utils.tree import WalkBudget, WalkCall, tree_walk
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec, ReaddirFn
from mirage.utils.key_prefix import under_path
from mirage.utils.path import CycleError
from mirage.view.types import LinkView, MountView


@dataclass(slots=True)
class DuTally:
    """What the walks of one ``du`` invocation met.

    Each operand's walk lists at most ``walk_limit`` entries of each
    mount it crosses (``WalkBudget``): a walk the mount's ``read_tree``
    does not answer takes one ``readdir`` per directory, which on an
    API-backed tree is one request per directory. Slack, for instance,
    exposes a directory per channel per day, so an unbounded walk of a
    real workspace is tens of thousands of requests. Where a walk ran out
    is kept, so the answer says it is partial.

    It also collects the directories the walk could not open (a rule
    refused them below the operand), which the generic reports after
    the walks the way GNU names an unreadable directory, and every
    directory it met, which is how one no file points at (an empty one,
    or a refused one) still gets GNU's row.

    Args:
        mounts (MountView | None): the mount table the limits come from.
        stopped (list[str]): where a walk ran out, in the order met.
        unreadable (list[str]): virtual paths of the directories the
            walk could not open, in the order it met them.
        directories (list[str]): virtual paths of every directory the
            last walk met, the operand's own included: each walk starts it
            afresh, so an operand's rows are its own walk's.
        inaccessible (list[tuple[str, str | None]]): under ``-L``, each
            link that leads nowhere, with the strerror GNU adds for a
            chain that loops.
    """

    mounts: MountView | None = None
    stopped: list[str] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)
    directories: list[str] = field(default_factory=list)
    inaccessible: list[tuple[str, str | None]] = field(default_factory=list)


def _account_for_walk_error(
    exc: Exception, path: PathSpec, tally: DuTally
) -> None:
    """Account for an error the walk met at ``path``, or re-raise it.

    Absence counts as zero, because an entry listed a moment ago can be
    gone by the time the walk reaches it, with ENOTDIR for one whose
    directory became a plain file meanwhile. A refusal counts as zero
    too, but never silently: GNU ``du`` skips what it cannot read, names
    it on stderr and exits 1, so the path is recorded here for the
    generic to report. Everything else (a 429, a 5xx, an aborted line)
    says the walk never saw that subtree, and a confidently wrong size is
    worse than an unknown one, so it surfaces instead of being summed as
    nothing.

    Both of the walk's calls come through here, because a refused
    ``stat`` is the same fact as a refused ``readdir``: a rule denying a
    path outright refuses before the walk ever learns the entry is a
    directory.

    Args:
        exc (Exception): what the stat or readdir raised.
        path (PathSpec): where the walk met it.
        tally (DuTally): records the refused directories.
    """
    if isinstance(exc, PermissionError):
        tally.unreadable.append(path.virtual)
        return
    if not isinstance(
        exc, (FileNotFoundError, NotADirectoryError, ValueError)
    ):
        raise exc


@dataclass(slots=True)
class Dereference:
    """What ``du -L`` follows links by, for one invocation.

    GNU counts each file once, under the first name its walks meet, across
    every operand of the line (coreutils 9.7): what one operand reaches
    is not counted again under another, and an operand already counted
    prints nothing. A link leading back into its operand's
    own tree waits for the walk to end, and counts only if the walk never
    reached the file under the file's own name: mirage's sorted walk
    prefers that name (where GNU's readdir order may reach the link
    first), and a directory the walk may not list leaves the link the one
    name that reaches the file, which GNU then counts it under. Under
    ``-x`` a link that leads onto another mount is left out whole, as GNU
    leaves out what stat(2) places on another device.

    Args:
        links (LinkView): the namespace's symlink facts.
        mounts (MountView | None): the mount boundaries ``-x`` keeps the
            walks within, None without ``-x``.
        counted (set[str]): what the walks counted so far, each as the
            path it resolves to.
        tree (str): the operand being walked, as the path it resolves to.
        home (str | None): under ``-x``, the mount that operand lies on.
        waiting (list[tuple[PathSpec, str]]): the walk's links into its
            tree, each with the path it resolves to.
    """

    links: LinkView
    mounts: MountView | None = None
    counted: set[str] = field(default_factory=set)
    tree: str = "/"
    home: str | None = None
    waiting: list[tuple[PathSpec, str]] = field(default_factory=list)

    def operand(self, path: PathSpec) -> "Dereference":
        """This invocation's state, walking one operand.

        Args:
            path (PathSpec): the operand.
        """
        tree = self.links.resolve(path.virtual)
        home = self.mounts.root_of(tree) if self.mounts is not None else None
        return replace(self, tree=tree, home=home, waiting=[])

    def repeated(self, path: PathSpec) -> bool:
        """Whether an earlier operand's walk already counted this one.

        Args:
            path (PathSpec): the operand.
        """
        return self.links.resolve(path.virtual) in self.counted


async def _counted(
    follow: Dereference, path: PathSpec, info: FileStat, tally: DuTally
) -> FileStat | None:
    """What ``du -L`` counts an entry as, None when it counts nothing.

    Args:
        follow (Dereference): the walk's dereference state.
        path (PathSpec): the entry.
        info (FileStat): its own stat, a link's row for a link.
        tally (DuTally): records a link it cannot follow.
    """
    try:
        real = follow.links.resolve(path.virtual)
        target = (
            await follow.links.target_stat(path.virtual)
            if info.type == FileType.SYMLINK
            else info
        )
    except FS_ERRORS + (CycleError,) as exc:
        tally.inaccessible.append((path.virtual, fs_strerror(exc)))
        return None
    if target is None:
        tally.inaccessible.append((path.virtual, None))
        return None
    if (
        follow.home is not None
        and follow.mounts is not None
        and follow.mounts.root_of(real) != follow.home
    ):
        return None
    if info.type == FileType.SYMLINK and under_path(real, follow.tree):
        follow.waiting.append((path, real))
        return None
    if real in follow.counted:
        return None
    follow.counted.add(real)
    return target


@dataclass(frozen=True)
class Walk:
    """The walk's readdir and stat, answered from the mount's
    ``read_tree`` where it can.

    Args:
        readdir (WalkCall): the walk's listing.
        stat (WalkCall): the walk's stat.
    """

    readdir: WalkCall
    stat: WalkCall


async def _du_walk(
    walk: Walk,
    path: PathSpec,
    tally: DuTally,
    scan: WalkBudget,
    entries: list[tuple[str, int]] | None,
    follow: Dereference | None = None,
) -> int:
    try:
        info = await walk.stat(path)
    except Exception as exc:
        _account_for_walk_error(exc, path, tally)
        return 0
    if follow is not None:
        counted = await _counted(follow, path, info, tally)
        if counted is None:
            return 0
        info = counted
    if info.type != FileType.DIRECTORY:
        size = info.size or 0
        if entries is not None:
            entries.append(("/" + path.virtual.strip("/"), size))
        return size
    tally.directories.append(path.virtual)
    if not scan.opens(path.virtual):
        return 0
    limit = scan.listing_limit(path.virtual)
    try:
        children = await (
            walk.readdir(path)
            if limit is None
            else walk.readdir(path, limit=limit)
        )
    except Exception as exc:
        _account_for_walk_error(exc, path, tally)
        return 0
    total = 0
    for child in children:
        if not scan.spend(path.virtual):
            break
        child_spec = PathSpec(
            virtual=child,
            directory=child,
            resolved=False,
            vfs_path=child.strip("/"),
        )
        total += await _du_walk(walk, child_spec, tally, scan, entries, follow)
    return total


def _tree_of(files: CommandFiles, listing: ReaddirFn) -> Walk:
    """The walk's readdir and stat, answered from the mount's
    ``read_tree`` where it can.

    Args:
        files (CommandFiles): the command's files.
        listing (ReaddirFn): the walk's own listing.
    """
    readdir, stat = tree_walk(
        files.read_tree, listing, files.stat, files.answers("read_tree")
    )
    return Walk(readdir=readdir, stat=stat)


async def _walk_operand(
    walk: Walk,
    tally: DuTally,
    follow: Dereference | None,
    path: PathSpec,
    entries: list[tuple[str, int]] | None = None,
) -> int:
    """Walk one operand, then count each link into its tree whose file
    the walk never reached under the file's own name.

    Args:
        walk (Walk): the walk's calls.
        tally (DuTally): what the invocation's walks met.
        follow (Dereference | None): the invocation's ``-L`` state.
        path (PathSpec): the operand.
        entries (list[tuple[str, int]] | None): collects each file's
            size under its name; None for a total alone.
    """
    tally.directories.clear()
    scan = WalkBudget(path, tally.mounts)
    state = follow.operand(path) if follow is not None else None
    total = await _du_walk(walk, path, tally, scan, entries, state)
    if state is not None:
        for link, real in state.waiting:
            if real not in state.counted:
                total += await _du_walk(
                    walk,
                    link,
                    tally,
                    scan,
                    entries,
                    replace(state, tree=link.virtual),
                )
    tally.stopped.extend(
        line for line in scan.stopped if line not in tally.stopped
    )
    return total


async def walk_size(
    walk: Walk,
    tally: DuTally,
    follow: Dereference | None,
    path: PathSpec,
) -> int:
    return await _walk_operand(walk, tally, follow, path)


async def walk_entries(
    walk: Walk,
    tally: DuTally,
    follow: Dereference | None,
    path: PathSpec,
) -> DuEntries:
    entries: list[tuple[str, int]] = []
    total = await _walk_operand(walk, tally, follow, path, entries)
    entries.sort()
    return entries, total


async def du(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    fl = FlagView(ctx.flags, spec=SPECS["du"])
    mounts = mounts_of(ctx)
    tally = DuTally(mounts=mounts)
    # Kept on one filesystem, a listing leaves out the roots
    # of the mounts below it, which the walk must neither list nor stat.
    # Those names would count toward a cut listing the walk then finds
    # short, so such a listing is never cut.
    bound = mount_view(ctx.vfs) if fl.as_bool("one_file_system") else None

    async def listing(path: PathSpec, limit: int | None = None) -> list[str]:
        if bound is None:
            return await files.readdir(path, limit=limit)
        entries = await files.readdir(path)
        owner = bound.root_of(path.virtual)
        return [e for e in entries if bound.root_of(e.rstrip("/")) == owner]

    links = links_of(ctx)
    follow = (
        Dereference(links, mounts if fl.as_bool("one_file_system") else None)
        if links is not None and fl.typed_order("L", "P")[-1:] == ["L"]
        else None
    )

    async def compute_size(path: PathSpec) -> int:
        return await walk_size(_tree_of(files, listing), tally, follow, path)

    async def compute_entries(path: PathSpec) -> DuEntries:
        return await walk_entries(
            _tree_of(files, listing), tally, follow, path
        )

    return await du_generic(
        paths,
        list(texts),
        ctx,
        files.resolve_glob,
        files.stat,
        compute_size,
        compute_entries,
        stopped=lambda: tally.stopped,
        unreadable=lambda: tally.unreadable,
        directories=lambda: tally.directories,
        inaccessible=lambda: tally.inaccessible,
        repeated=follow.repeated if follow is not None else None,
    )


BUILDER = GenericCommand("du", du)
