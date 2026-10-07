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

from dataclasses import dataclass, field
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.du import (
    ComputeEntries,
    ComputeSize,
    du_generic,
)
from mirage.commands.builtin.generic_bind.adapter import Builder
from mirage.commands.config import CommandIO, CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import MountView
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of, rekey
from mirage.vfs.types import DuEntries


@dataclass(slots=True)
class WalkBudget:
    """Entry allowance shared by every operand of one ``du`` invocation.

    Backends with no native du op are walked one ``readdir`` at a time,
    which on an API-backed tree is one request per directory. Slack, for
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
            walk met, the operand's own included.
        mounts (MountView | None): the mount table, for a walk with no
            cap of its own.
        spent (dict[str, int]): entries charged so far per mount root.
    """

    remaining: int | None
    hit: bool = False
    unreadable: list[str] = field(default_factory=list)
    directories: list[str] = field(default_factory=list)
    mounts: MountView | None = None
    spent: dict[str, int] = field(default_factory=dict)

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

    Both of the walk's doors come through here, because a refused
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


async def _du_walk(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    path: PathSpec,
    budget: WalkBudget,
    entries: list[tuple[str, int]] | None,
) -> int:
    try:
        info = await ops.stat(accessor, path, index)
    except Exception as exc:
        _account_for_walk_error(exc, path, budget)
        return 0
    if info.type != FileType.DIRECTORY:
        size = info.size or 0
        if entries is not None:
            prefix = mount_prefix_of(path.virtual, path.vfs_path)
            entries.append(("/" + mount_key(path.virtual, prefix), size))
        return size
    budget.directories.append(path.virtual)
    try:
        children = await ops.readdir(accessor, path, index)
    except Exception as exc:
        _account_for_walk_error(exc, path, budget)
        return 0
    total = 0
    for child in children:
        if not budget.spend(path.virtual):
            break
        child_spec = PathSpec(
            virtual=child,
            directory=child,
            resolved=False,
            vfs_path=rekey(path.virtual, path.vfs_path, child),
        )
        total += await _du_walk(
            ops, accessor, index, child_spec, budget, entries
        )
    return total


async def walk_size(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    path: PathSpec,
) -> int:
    return await _du_walk(ops, accessor, index, path, budget, None)


async def walk_entries(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    path: PathSpec,
) -> DuEntries:
    entries: list[tuple[str, int]] = []
    total = await _du_walk(ops, accessor, index, path, budget, entries)
    entries.sort()
    return entries, total


async def du(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("du: no VFS")
    budget = WalkBudget(
        ops.max_du_entries, mounts=opts.ns.mounts if opts.ns else None
    )
    native = ops.du
    compute_size: ComputeSize
    compute_entries: ComputeEntries
    # Hides and path rules turn the native du off upstream (scoped_io),
    # so the walk is what reports a directory a rule refuses to open.
    if native is None:
        compute_size = partial(walk_size, ops, accessor, opts.index, budget)
        compute_entries = partial(
            walk_entries, ops, accessor, opts.index, budget
        )
    else:
        compute_size = partial(native.size, accessor, index=opts.index)
        compute_entries = partial(native.entries, accessor, index=opts.index)
    return await du_generic(
        paths,
        list(texts),
        opts,
        lambda targets: ops.resolve_glob(accessor, targets, opts.index),
        lambda p: ops.stat(accessor, p, opts.index),
        compute_size,
        compute_entries,
        truncated=lambda: budget.hit,
        unreadable=lambda: budget.unreadable,
        directories=lambda: budget.directories,
    )


BUILDER = Builder("du", du)
