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
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.du import (
    ComputeEntries,
    ComputeSize,
    du_generic,
)
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
)
from mirage.commands.builtin.utils.links import links_of, mounts_of
from mirage.commands.builtin.utils.tree import WalkCall, tree_walk
from mirage.commands.config import CommandIO, Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import (
    mount_key,
    mount_prefix_of,
    rekey,
    under_path,
)
from mirage.utils.path import CycleError
from mirage.vfs.types import DuEntries
from mirage.view.types import LinkView, MountView


@dataclass(slots=True)
class WalkBudget:
    """Entry allowance shared by every operand of one ``du`` invocation.

    A walk the mount's ``read_tree`` does not answer takes one
    ``readdir`` per directory, which on an API-backed tree is one request
    per directory. Slack, for
    instance, exposes a directory per channel per day, so an unbounded
    walk of a real workspace is tens of thousands of requests. The budget
    stops the walk and records that the answer is partial.

    It also collects the directories the walk could not open (a rule
    refused them below the operand), which the generic reports after
    the walks the way GNU names an unreadable directory, and every
    directory it met, which is how one no file points at (an empty one,
    or a refused one) still gets GNU's row.

    A walk with no cap of its own (the dispatcher's, which spans mounts)
    defers to the mounts it crosses: each entry is charged to the mount
    serving it, at that mount's own cap, so a disk tree below a capped
    root is not cut short and a service below an uncapped one is not
    walked without its bound.

    Args:
        remaining (int | None): entries still allowed, or None for no cap.
        hit (bool): whether the cap was reached.
        unreadable (list[str]): virtual paths of the directories the
            walk could not open, in the order it met them.
        directories (list[str]): virtual paths of every directory the
            last walk met, the operand's own included: each walk starts it
            afresh, so an operand's rows are its own walk's.
        mounts (MountView | None): the mount table, for a walk with no
            cap of its own.
        spent (dict[str, int]): entries charged so far per mount root.
        inaccessible (list[tuple[str, str | None]]): under ``-L``, each
            link that leads nowhere, with the strerror GNU adds for a
            chain that loops.
    """

    remaining: int | None
    hit: bool = False
    unreadable: list[str] = field(default_factory=list)
    directories: list[str] = field(default_factory=list)
    mounts: MountView | None = None
    spent: dict[str, int] = field(default_factory=dict)
    inaccessible: list[tuple[str, str | None]] = field(default_factory=list)

    def spend(self, path: str) -> bool:
        """Charge one entry to the budget.

        Args:
            path (str): virtual path of the directory whose listing names
                the entry, so a mount root is charged to its parent, as
                the parent's own walk would count it.

        Returns:
            bool: True if the walk may continue, False once exhausted.
        """
        if self.remaining is not None:
            if self.remaining <= 0:
                self.hit = True
                return False
            self.remaining -= 1
            return True
        if self.mounts is None or self.mounts.max_du_entries is None:
            return True
        cap = self.mounts.max_du_entries(path)
        if cap is None:
            return True
        owner = self.mounts.root_of(path)
        used = self.spent.get(owner, 0)
        if used >= cap:
            self.hit = True
            return False
        self.spent[owner] = used + 1
        return True


def _account_for_walk_error(
    exc: Exception, path: PathSpec, budget: WalkBudget
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
        budget (WalkBudget): records the refused directories.
    """
    if isinstance(exc, PermissionError):
        budget.unreadable.append(path.virtual)
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
    follow: Dereference, path: PathSpec, info: FileStat, budget: WalkBudget
) -> FileStat | None:
    """What ``du -L`` counts an entry as, None when it counts nothing.

    Args:
        follow (Dereference): the walk's dereference state.
        path (PathSpec): the entry.
        info (FileStat): its own stat, a link's row for a link.
        budget (WalkBudget): records a link it cannot follow.
    """
    try:
        real = follow.links.resolve(path.virtual)
        target = (
            await follow.links.target_stat(path.virtual)
            if info.type == FileType.SYMLINK
            else info
        )
    except FS_ERRORS + (CycleError,) as exc:
        budget.inaccessible.append((path.virtual, fs_strerror(exc)))
        return None
    if target is None:
        budget.inaccessible.append((path.virtual, None))
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


async def _du_walk(
    walk: tuple[WalkCall, WalkCall, set[str]],
    index: IndexCacheStore,
    path: PathSpec,
    budget: WalkBudget,
    entries: list[tuple[str, int]] | None,
    follow: Dereference | None = None,
) -> int:
    readdir, stat, answered = walk
    try:
        info = await stat(path, index)
    except Exception as exc:
        _account_for_walk_error(exc, path, budget)
        return 0
    if follow is not None:
        counted = await _counted(follow, path, info, budget)
        if counted is None:
            return 0
        info = counted
    if info.type != FileType.DIRECTORY:
        size = info.size or 0
        if entries is not None:
            prefix = mount_prefix_of(path.virtual, path.vfs_path)
            entries.append(("/" + mount_key(path.virtual, prefix), size))
        return size
    budget.directories.append(path.virtual)
    try:
        children = await readdir(path, index)
    except Exception as exc:
        _account_for_walk_error(exc, path, budget)
        return 0
    total = 0
    free = (path.virtual.rstrip("/") or "/") in answered
    for child in children:
        if not free and not budget.spend(path.virtual):
            break
        child_spec = PathSpec(
            virtual=child,
            directory=child,
            resolved=False,
            vfs_path=rekey(path.virtual, path.vfs_path, child),
        )
        total += await _du_walk(
            walk, index, child_spec, budget, entries, follow
        )
    return total


def _walk(
    ops: CommandIO, accessor: Accessor, index: IndexCacheStore
) -> tuple[WalkCall, WalkCall, set[str]]:
    """The walk's readdir and stat, answered from the mount's
    ``read_tree`` where it can, and the directories listed that way,
    which cost no request and so no budget.

    Args:
        ops (CommandIO): the mount's table.
        accessor (Accessor): the mounted backend.
        index (IndexCacheStore): cache index threaded through reads.
    """
    answered: set[str] = set()
    readdir, stat = tree_walk(
        bound_op(ops.read_tree, accessor, index),
        partial(ops.readdir, accessor),
        partial(ops.stat, accessor),
        answered=answered,
    )
    return readdir, stat, answered


async def _walk_operand(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    follow: Dereference | None,
    path: PathSpec,
    entries: list[tuple[str, int]] | None = None,
) -> int:
    """Walk one operand, then count each link into its tree whose file
    the walk never reached under the file's own name.

    Args:
        ops (CommandIO): the mount's table.
        accessor (Accessor): the mounted backend.
        index (IndexCacheStore): cache index threaded through reads.
        budget (WalkBudget): the invocation's allowance and records.
        follow (Dereference | None): the invocation's ``-L`` state.
        path (PathSpec): the operand.
        entries (list[tuple[str, int]] | None): collects each file's
            size under its name; None for a total alone.
    """
    budget.directories.clear()
    walk = _walk(ops, accessor, index)
    state = follow.operand(path) if follow is not None else None
    total = await _du_walk(walk, index, path, budget, entries, state)
    if state is not None:
        for link, real in state.waiting:
            if real not in state.counted:
                total += await _du_walk(
                    walk,
                    index,
                    link,
                    budget,
                    entries,
                    replace(state, tree=link.virtual),
                )
    return total


async def walk_size(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    follow: Dereference | None,
    path: PathSpec,
) -> int:
    return await _walk_operand(ops, accessor, index, budget, follow, path)


async def walk_entries(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    follow: Dereference | None,
    path: PathSpec,
) -> DuEntries:
    entries: list[tuple[str, int]] = []
    total = await _walk_operand(
        ops, accessor, index, budget, follow, path, entries
    )
    entries.sort()
    return entries, total


async def du(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("du: no VFS")
    mounts = mounts_of(ctx)
    budget = WalkBudget(ops.max_du_entries, mounts=mounts)
    fl = FlagView(ctx.flags, spec=SPECS["du"])
    links = links_of(ctx)
    follow = (
        Dereference(links, mounts if fl.as_bool("one_file_system") else None)
        if links is not None and fl.typed_order("L", "P")[-1:] == ["L"]
        else None
    )
    compute_size: ComputeSize = partial(
        walk_size, ops, accessor, ctx.index, budget, follow
    )
    compute_entries: ComputeEntries = partial(
        walk_entries, ops, accessor, ctx.index, budget, follow
    )
    return await du_generic(
        paths,
        list(texts),
        ctx,
        lambda targets: ops.resolve_glob(accessor, targets, ctx.index),
        lambda p: ops.stat(accessor, p, ctx.index),
        compute_size,
        compute_entries,
        truncated=lambda: budget.hit,
        unreadable=lambda: budget.unreadable,
        directories=lambda: budget.directories,
        inaccessible=lambda: budget.inaccessible,
        repeated=follow.repeated if follow is not None else None,
    )


BUILDER = GenericCommand("du", du)
