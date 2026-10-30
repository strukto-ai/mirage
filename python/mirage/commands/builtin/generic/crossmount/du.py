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

from dataclasses import replace

from mirage.commands.builtin.constants import OPERAND_CONCURRENCY
from mirage.commands.builtin.generic.crossmount.constants import (
    DISPATCH_BUILDERS,
)
from mirage.commands.builtin.generic.crossmount.scopes import (
    mount_starts,
    reached,
)
from mirage.commands.builtin.generic.crossmount.types import (
    CrossResult,
    RunSingle,
)
from mirage.commands.builtin.generic.du import du, leaves_of, parse_flags
from mirage.commands.builtin.generic_bind.dispatch import run_dispatch
from mirage.commands.builtin.utils.links import mount_view
from mirage.commands.builtin.utils.paths import virtual_key
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.concurrency.limiter import bounded_map
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, PathRecord
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.view.types import FollowOperands
from mirage.workspace.files import Files

# The flags that shape only the rendering: every mount measures without
# them, and the line renders once.
RENDERING = frozenset({"s", "max_depth"})


async def run_du(
    paths: list[PathSpec],
    texts: list[str],
    flags: dict[str, FlagValue],
    dispatch: DispatchFn,
    run_single: RunSingle,
    cwd: str,
    vfs: Files | None = None,
    stdin: ByteSource | None = None,
    nested: bool = False,
    follow: FollowOperands | None = None,
) -> CrossResult:
    """Render du over operands spanning mounts from each mount's own du.

    Every start point is measured by the du its mount registered, a few
    at a time, and the measurements (``IOResult.records``) render as
    one tree: a directory's row counts the mounts inside it, and ``-c``
    totals the line. No mount's output text is read back. A mount whose
    du fails adds its diagnostic and status, and the mounts below it
    count only where the walk could still reach them (``reached``); one
    that succeeds without a measurement (a du not built on
    ``du_generic``) leaves the line to the one dispatcher walk.

    Args:
        paths (list[PathSpec]): Operands in command-line order.
        texts (list[str]): Text operands, unused by du.
        flags (dict[str, FlagValue]): The parsed flags.
        dispatch (DispatchFn): Workspace operations, for the one walk.
        run_single (RunSingle): Runs one start point on its mount.
        cwd (str): The session's working directory.
        vfs (Files | None): Mount ownership and link facts.
        stdin (ByteSource | None): The command's input.
        nested (bool): ``run_single`` answers only its own mount's part,
            so the mounts below each operand are measured here unless
            ``-x`` keeps the walk on one filesystem; otherwise each
            operand's run composes its own.
        follow (FollowOperands | None): The line's operand resolution,
            which the one walk's globs take.
    """
    rendering = parse_flags(Context(flags=flags))
    if isinstance(rendering, IOResult):
        return None, rendering
    bounded = FlagView(flags, spec=SPECS["du"]).as_bool("one_file_system")
    measuring = {k: v for k, v in flags.items() if k not in RENDERING}
    # Each start is then one mount's own part, and keeps only what that
    # mount owns: a part walked through the dispatcher reaches the mounts
    # below it too, which measure themselves.
    mounts = mount_view(vfs) if nested and not bounded else None
    plan = [
        (index, start)
        for index, path in enumerate(paths)
        for start in (mount_starts(path, vfs) if mounts else [path])
    ]

    async def measure(step: tuple[int, PathSpec]) -> IOResult:
        out, io = await run_single("du", [step[1]], texts, measuring)
        await materialize(out)
        return io

    ios = await bounded_map(plan, measure, OPERAND_CONCURRENCY)
    # A run that failed measured nothing and says why; one that succeeded
    # without a measurement is a du this line cannot compose.
    if any(io.records is None and io.exit_code == 0 for io in ios):
        return await run_dispatch(
            DISPATCH_BUILDERS["du"],
            paths,
            texts,
            flags,
            dispatch,
            cwd,
            vfs,
            stdin,
            follow=follow,
        )
    kept = await reached(
        paths, plan, [io.exit_code != 0 for io in ios], dispatch
    )
    done = [(step, io) for step, io, keep in zip(plan, ios, kept) if keep]
    found: list[list[PathRecord]] = [[] for _ in paths]
    present = [False] * len(paths)
    merged = IOResult()
    for (index, start), io in done:
        owner = mounts.root_of(start.virtual) if mounts else None
        owned = [
            r
            for r in io.records or []
            if mounts is None or mounts.root_of(r.path.virtual) == owner
        ]
        if start is paths[index]:
            present[index] = bool(io.records)
        elif all(
            leaf.rstrip("/") != start.virtual.rstrip("/")
            for leaf, _ in leaves_of(owned)
        ):
            # A mount root holding nothing still gets its row, unless
            # the mount is one file (/.bash_history).
            found[index].append(PathRecord(start, index))
        # A run's record of its own start is left out: the line renders
        # the operand's row from the operand, and a mount root's as above.
        found[index].extend(
            replace(r, run=index)
            for r in owned
            if r.size is not None
            or r.path.virtual.rstrip("/") != start.virtual.rstrip("/")
        )
        merged = await merged.merge(io)
    targets: list[PathSpec] = []
    measured: dict[PathSpec, list[PathRecord]] = {}
    records: list[PathRecord] = []
    for index, path in enumerate(paths):
        if present[index]:
            target = virtual_key(path)
            targets.append(target)
            measured[target] = found[index]
            records += [PathRecord(target, index), *found[index]]

    async def entries(path: PathSpec) -> tuple[list[tuple[str, int]], int]:
        counted = leaves_of(measured[path])
        return counted, sum(size for _, size in counted)

    async def size(path: PathSpec) -> int:
        return (await entries(path))[1]

    out = await du(
        targets,
        compute_size=size,
        compute_entries=entries,
        flags=rendering,
        directories=lambda: [
            r.path.virtual
            for rows in measured.values()
            for r in rows
            if r.size is None
        ],
    )
    merged.stderr = out.stderr + await materialize(merged.stderr)
    merged.exit_code = max([out.exit_code, *(io.exit_code for _, io in done)])
    merged.records = records
    return out.stdout, merged
