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

from dataclasses import dataclass
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.du import (ComputeEntries, ComputeSize,
                                                DuEntries)
from mirage.commands.builtin.generic.du import du as generic_du
from mirage.commands.builtin.generic.du import (du_has_content, du_operands,
                                                parse_flags)
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          OperationFn)
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of, rekey


@dataclass(slots=True)
class WalkBudget:
    """Entry allowance shared by every operand of one ``du`` invocation.

    Backends with no native du op are walked one ``readdir`` at a time,
    which on an API-backed tree is one request per directory. Slack, for
    instance, exposes a directory per channel per day, so an unbounded
    walk of a real workspace is tens of thousands of requests. The budget
    stops the walk and records that the answer is partial.

    Args:
        remaining (int | None): entries still allowed, or None for no cap.
        hit (bool): whether the cap was reached.
    """

    remaining: int | None
    hit: bool = False

    def spend(self) -> bool:
        """Charge one entry to the budget.

        Returns:
            bool: True if the walk may continue, False once exhausted.
        """
        if self.remaining is None:
            return True
        if self.remaining <= 0:
            self.hit = True
            return False
        self.remaining -= 1
        return True


async def _walk(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    path: PathSpec,
    budget: WalkBudget,
    entries: list[tuple[str, int]] | None,
) -> int:
    try:
        info = await ops.stat(accessor, path, index)
    except (FileNotFoundError, ValueError):
        return 0
    if info.type != FileType.DIRECTORY:
        size = info.size or 0
        if entries is not None:
            prefix = mount_prefix_of(path.virtual, path.resource_path)
            entries.append(("/" + mount_key(path.virtual, prefix), size))
        return size
    try:
        children = await ops.readdir(accessor, path, index)
    except (FileNotFoundError, ValueError):
        return 0
    total = 0
    for child in children:
        if not budget.spend():
            break
        child_spec = PathSpec(virtual=child,
                              directory=child,
                              resolved=False,
                              resource_path=rekey(path.virtual,
                                                  path.resource_path, child))
        total += await _walk(ops, accessor, index, child_spec, budget, entries)
    return total


async def _walk_size(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    path: PathSpec,
) -> int:
    return await _walk(ops, accessor, index, path, budget, None)


async def _walk_entries(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    budget: WalkBudget,
    path: PathSpec,
) -> DuEntries:
    entries: list[tuple[str, int]] = []
    total = await _walk(ops, accessor, index, path, budget, entries)
    entries.sort()
    return entries, total


async def _op_size(
    op: OperationFn,
    accessor: Accessor,
    index: IndexCacheStore,
    path: PathSpec,
) -> int:
    return await op(accessor, path, index)


async def _op_entries(
    op: OperationFn,
    accessor: Accessor,
    index: IndexCacheStore,
    path: PathSpec,
) -> DuEntries:
    return await op(accessor, path, index)


async def du(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    h: bool = False,
    s: bool = False,
    a: bool = False,
    max_depth: str | None = None,
    d: str | None = None,
    c: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    cwd: PathSpec | str = "/",
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("du: no resource")
    # GNU rejects a bad option combination before it stats anything, and
    # -d is only another spelling of --max-depth.
    flags = parse_flags(s=s,
                        a=a,
                        h=h,
                        c=c,
                        max_depth=max_depth if max_depth is not None else d)
    budget = WalkBudget(ops.max_du_entries)
    size_op = ops.du_size
    entries_op = ops.du_entries
    compute_size: ComputeSize
    compute_entries: ComputeEntries | None
    if size_op is None:
        compute_size = partial(_walk_size, ops, accessor, index, budget)
        compute_entries = partial(_walk_entries, ops, accessor, index, budget)
    else:
        compute_size = partial(_op_size, size_op, accessor, index)
        compute_entries = (partial(_op_entries, entries_op, accessor, index)
                           if entries_op is not None else None)

    present, missing = await du_operands(
        paths,
        cwd,
        lambda targets: ops.resolve_glob(accessor, targets, index),
        lambda path: ops.stat(accessor, path, index),
        partial(du_has_content, compute_size, compute_entries),
    )
    out = await generic_du(
        present,
        compute_size=compute_size,
        compute_entries=compute_entries,
        flags=flags,
        missing=missing,
        truncated=lambda: budget.hit,
    )
    return out.stdout, IOResult(stderr=out.stderr, exit_code=out.exit_code)


BUILDER = Builder('du', du, None, False, None)
