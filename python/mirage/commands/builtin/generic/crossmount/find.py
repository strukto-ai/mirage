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

from mirage.commands.builtin.constants import (
    EXEC_BATCH_END,
    EXEC_END,
    FIND_EXEC_PREDICATES,
    FIND_VALUE_PREDICATES,
)
from mirage.commands.builtin.find_parse import parse_find_expression
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
from mirage.commands.builtin.generic_bind.dispatch import run_dispatch
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.concurrency.limiter import bounded_map
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.ops.types import NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec
from mirage.utils.path import respell_one

# The tests whose verdict on one entry decides what the walk reads below
# it, or that read a listing a mount boundary splits: no mount's own find
# can answer them for the whole tree, so such a line keeps the one walk.
WALK_WIDE = frozenset({"-prune", "-empty", "-xdev", "-mount"})


def predicates(texts: list[str]) -> list[tuple[int, str]]:
    """Each word of a find expression that is not another word's argument.

    Args:
        texts (list[str]): The expression words.
    """
    found: list[tuple[int, str]] = []
    i = 0
    while i < len(texts):
        found.append((i, texts[i]))
        if texts[i] in FIND_VALUE_PREDICATES:
            i += 1
        elif texts[i] in FIND_EXEC_PREDICATES:
            i += 1
            while i < len(texts) and not (
                texts[i] == EXEC_END
                or (texts[i] == EXEC_BATCH_END and texts[i - 1] == "{}")
            ):
                i += 1
        i += 1
    return found


def shifted(
    texts: list[str],
    flags: dict[str, FlagValue],
    depth: int,
    maxdepth: int | None,
    mindepth: int | None,
    alone: bool = False,
) -> tuple[list[str], dict[str, FlagValue]] | None:
    """The expression for a start point ``depth`` levels below the operand.

    Its depth limits count from that start point. None when the limits
    leave it nothing to print.

    Args:
        texts (list[str]): The expression words.
        flags (dict[str, FlagValue]): The parsed flags.
        depth (int): Levels between the operand and the start point.
        maxdepth (int | None): The expression's ``-maxdepth``.
        mindepth (int | None): The expression's ``-mindepth``.
        alone (bool): Match the start point only, not what lies below.
    """
    if maxdepth is not None and depth > maxdepth:
        return None
    if alone and mindepth is not None and depth < mindepth:
        return None
    top = 0 if alone else None if maxdepth is None else maxdepth - depth
    bottom = None if mindepth is None else max(0, mindepth - depth)
    limits = {"-maxdepth": top, "-mindepth": bottom}
    words = list(texts)
    bag = dict(flags)
    for i, word in predicates(texts):
        limit = limits.get(word)
        if limit is not None:
            words[i + 1] = str(limit)
            bag[word.lstrip("-")] = str(limit)
    if alone and "maxdepth" not in bag:
        words = ["-maxdepth", "0", *words]
        bag["maxdepth"] = "0"
    return words, bag


def joints(path: PathSpec, starts: list[PathSpec]) -> list[PathSpec]:
    """The directories between an operand and the mounts below it.

    No mount's own find can answer for them: the parent's backend may
    hold none of them (a mount at ``/usr/bin`` implies ``/usr``), so
    each is matched alone, through the dispatcher.

    Args:
        path (PathSpec): The operand.
        starts (list[PathSpec]): Its ``mount_starts``.
    """
    base = path.virtual.rstrip("/")
    roots = {start.virtual for start in starts[1:]}
    between: set[str] = set()
    for root in roots:
        parts = root[len(base) :].strip("/").split("/")[:-1]
        for end in range(1, len(parts) + 1):
            between.add(base + "/" + "/".join(parts[:end]))
    return [
        PathSpec(
            virtual=virtual,
            directory=virtual,
            vfs_path=virtual.strip("/"),
            raw_path=respell_one(virtual, path.virtual, path.raw_path),
        )
        for virtual in sorted(between - roots)
    ]


async def run_find(
    paths: list[PathSpec],
    texts: list[str],
    flags: dict[str, FlagValue],
    dispatch: DispatchFn,
    run_single: RunSingle,
    cwd: str,
    ns: NamespaceView | None = None,
    stdin: ByteSource | None = None,
) -> CrossResult:
    """Compose find over operands holding mounts from each mount's own find.

    Every operand, and every visible mount below it, runs the find its
    mount registered, a few at a time, with the depth limits counted
    from its own start point; the directories between them (``joints``)
    are matched once each through the dispatcher. Each run answers for
    the rows its mount owns (the parent's shadowed keys stay out), and
    the rows merge in the walk's path order, so the actions still run
    once over every mount's ``matched_runs``; a mount whose find fails
    adds its diagnostic and status, as GNU's walk past an unreadable
    directory does, and the mounts below it count only where the walk
    could still reach them (``reached``). An expression that looks across a boundary
    (``WALK_WIDE``, ``-L``), or a find that succeeds without structured
    rows, keeps the one dispatcher walk.

    Args:
        paths (list[PathSpec]): Operands in command-line order.
        texts (list[str]): The expression words.
        flags (dict[str, FlagValue]): The parsed flags.
        dispatch (DispatchFn): Workspace operations, for the one walk.
        run_single (RunSingle): Runs one start point on its mount alone.
        cwd (str): The session's working directory.
        ns (NamespaceView | None): Mount ownership and link facts.
        stdin (ByteSource | None): The command's input.
    """
    if (
        ns is None
        or ns.mounts is None
        or WALK_WIDE & {word for _, word in predicates(texts)}
        or FlagView(flags, spec=SPECS["find"]).as_bool("L")
    ):
        return await run_dispatch(
            DISPATCH_BUILDERS["find"],
            paths,
            texts,
            flags,
            dispatch,
            cwd,
            ns,
            stdin,
        )
    mounts = ns.mounts
    expr = parse_find_expression(list(texts))
    plan: list[tuple[int, PathSpec, bool, list[str], dict[str, FlagValue]]]
    plan = []
    for index, path in enumerate(paths):
        base = path.virtual.rstrip("/")
        starts = mount_starts(path, ns)
        steps = [(start, False) for start in starts]
        steps += [(joint, True) for joint in joints(path, starts)]
        for start, alone in steps:
            depth = (
                0 if start is path else start.virtual[len(base) :].count("/")
            )
            limited = shifted(
                texts, flags, depth, expr.maxdepth, expr.mindepth, alone
            )
            if limited is not None:
                plan.append((index, start, alone, *limited))

    async def search(
        step: tuple[int, PathSpec, bool, list[str], dict[str, FlagValue]],
    ) -> IOResult:
        _, start, alone, words, bag = step
        if alone:
            out, io = await run_dispatch(
                DISPATCH_BUILDERS["find"],
                [start],
                words,
                bag,
                dispatch,
                cwd,
                ns,
                stdin,
            )
        else:
            out, io = await run_single("find", [start], words, bag)
        await materialize(out)
        return io

    ios = await bounded_map(plan, search, 4)
    # A run that failed found no rows and says why; one that succeeded
    # without structured rows is a find this line cannot compose.
    if any(io.matched_runs is None and io.exit_code == 0 for io in ios):
        return await run_dispatch(
            DISPATCH_BUILDERS["find"],
            paths,
            texts,
            flags,
            dispatch,
            cwd,
            ns,
            stdin,
        )
    between = [
        {step[1].virtual for step in plan if step[0] == index and step[2]}
        for index in range(len(paths))
    ]
    kept = await reached(
        paths,
        [(step[0], step[1]) for step in plan],
        [io.exit_code != 0 for io in ios],
        dispatch,
    )
    done = [(step, io) for step, io, keep in zip(plan, ios, kept) if keep]
    runs: list[list[PathSpec]] = [[] for _ in paths]
    merged = IOResult()
    for (index, start, alone, _, _), io in done:
        owner = mounts.root_of(start.virtual)
        runs[index].extend(
            row
            for run in io.matched_runs or []
            for row in run
            if (
                row.virtual == start.virtual
                if alone
                else mounts.root_of(row.virtual) == owner
                and row.virtual not in between[index]
            )
        )
        merged = await merged.merge(io)
    for rows in runs:
        rows.sort(key=lambda row: row.virtual)
    merged.exit_code = max((io.exit_code for _, io in done), default=0)
    merged.matched_runs = runs
    body = b"".join(
        ((row.raw_path or row.virtual) + "\n").encode()
        for rows in runs
        for row in rows
    )
    return body, merged
