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

import logging

from mirage.commands.builtin.generic.crossmount.constants import (
    DISPATCH_BUILDERS,
)
from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    CrossResult,
    OperandRun,
    RunSingle,
)
from mirage.commands.builtin.generic.crossmount.utils import (
    merge_operand_ios,
    relay,
    run_operands,
)
from mirage.commands.builtin.generic.wc import (
    WCCounts,
    format_count_rows,
    number_width,
    parse_flags,
)
from mirage.commands.builtin.generic_bind.dispatch import run_dispatch
from mirage.commands.builtin.utils.stream import is_stdin
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import NamespaceView
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS

logger = logging.getLogger(__name__)

# GNU prints a row's counts in this order whichever flags ask for them.
COLUMNS = ("lines", "words", "chars", "bytes_", "max_line_length")


async def operand_size(
    dispatch: DispatchFn, path: PathSpec, counts: list[int]
) -> int | None:
    """The size GNU sizes the columns by, which it takes from fstat.

    A stream or a directory has none. A file whose size ``stat`` cannot
    give without rendering it, or that is gone by the time it is sized,
    counts as its widest count, a lower bound, which is the width a
    count-only mount pads to on its own.

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
        path (PathSpec): The operand the row counts.
        counts (list[int]): The counts the row shows.
    """
    if is_stdin(path):
        return None
    try:
        info = await relay(dispatch, "stat", path)
    except FS_ERRORS as exc:
        # Gone since its mount counted it: the width is only layout, so
        # the counts already taken still print, padded to the lower bound.
        logger.debug("wc: sizing %s failed: %s", path.virtual, exc)
        return max(counts)
    if info.type is FileType.DIRECTORY:
        return None
    return info.size if info.size is not None else max(counts)


async def recount(
    run: OperandRun,
    flags: dict[str, FlagValue],
    dispatch: DispatchFn,
    cwd: str,
    ns: NamespaceView | None,
    stdin: ByteSource | None,
) -> OperandRun:
    """The run as counted, recounting it through the dispatcher if needed.

    A mount's wc that succeeds without counts (one not built on the
    generic) leaves its operand to the generic over the dispatcher, and
    only that operand: the others keep what their own mount counted.

    Args:
        run (OperandRun): One operand's run on its own mount.
        flags (dict[str, FlagValue]): The flags every run takes.
        dispatch (DispatchFn): Workspace operation dispatcher.
        cwd (str): The session's working directory.
        ns (NamespaceView | None): Mount ownership and link facts.
        stdin (ByteSource | None): The command's input.
    """
    if run.io.counted_runs is not None or run.io.exit_code != 0:
        return run
    _, io = await run_dispatch(
        DISPATCH_BUILDERS[Cmd.WC],
        [run.scope],
        [],
        flags,
        dispatch,
        cwd,
        ns,
        stdin,
    )
    return OperandRun(run.scope, b"", io)


async def run_wc(
    scopes: list[PathSpec],
    flag_kwargs: dict[str, FlagValue],
    dispatch: DispatchFn,
    run_single: RunSingle,
    cwd: str = "/",
    ns: NamespaceView | None = None,
    stdin: ByteSource | None = None,
) -> CrossResult:
    """Count each operand on its own mount and lay the rows out together.

    Each operand runs through its owning mount's ``wc``, so a mount that
    counts without reading its file (a database row count) still does,
    and reading mounts stream. Only the layout spans the line: the counts
    each run reports (``IOResult.counted_runs``) go through the generic's
    formatter with GNU's column width, and no mount's output text is
    read back. A run that succeeds without counts is recounted on its
    own (``recount``).

    Args:
        scopes (list[PathSpec]): Expanded operands in command-line order.
        flag_kwargs (dict): Parsed wc flags.
        dispatch (DispatchFn): Workspace operation dispatcher, for sizes.
        run_single (RunSingle): Single-mount runner for each operand.
        cwd (str): The session's working directory.
        ns (NamespaceView | None): Mount ownership and link facts.
        stdin (ByteSource | None): The command's input.
    """
    try:
        flags = parse_flags(flag_kwargs)
    except UsageError as exc:
        return None, IOResult(
            exit_code=exc.exit_code, stderr=(str(exc) + "\n").encode()
        )
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    columns = [c for c in COLUMNS if getattr(flags, c)]
    columns = columns or ["lines", "words", "bytes_"]
    each = {**flag_kwargs, "total": "never"}
    runs = [
        await recount(run, each, dispatch, cwd, ns, stdin)
        for run in await run_operands(run_single, Cmd.WC, scopes, [], each)
    ]
    rows: list[tuple[WCCounts, str | None]] = []
    sizes: list[int | None] = []
    totals = WCCounts()
    for run in runs:
        for counted in run.io.counted_runs or []:
            counts = WCCounts(**dict(zip(columns, counted.values)))
            rows.append((counts, counted.label))
            sizes.append(
                await operand_size(dispatch, run.scope, list(counted.values))
            )
            totals.merge(counts)
    width = number_width(sizes, len(scopes), len(columns))
    body = format_count_rows(rows, totals, len(scopes), flags, width)
    return body, await merge_operand_ios(
        runs, max(run.io.exit_code for run in runs)
    )
