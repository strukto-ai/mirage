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

import dataclasses
import functools
from typing import Any, cast

from mirage.commands.builtin.generic.crossmount.types import (Cmd, OperandRun,
                                                              RunSingle)
from mirage.commands.builtin.generic.grep import \
    parse_flags as parse_grep_flags
from mirage.commands.builtin.generic.grep import \
    prints_context as grep_prints_context
from mirage.commands.builtin.generic.rg import \
    between_files as rg_between_files
from mirage.commands.builtin.generic.rg import parse_flags as parse_rg_flags
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line


async def relay(dispatch: DispatchFn, name: str, path: PathSpec,
                **kwargs: Any) -> Any:
    # Relay one op for one path to the mount that owns it. The generics call
    # ops as (path); dispatch keys off the path.
    data, _ = await dispatch(name, path, **kwargs)
    return data


async def read_file(dispatch: DispatchFn, io: IOResult,
                    path: PathSpec) -> bytes:
    """Read a relayed file and retain its cache/accounting envelope.

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
        io (IOResult): Input accounting to merge with the generic's result.
        path (PathSpec): Full virtual input path.
    """
    info = await relay(dispatch, "stat", path)
    if info.type is FileType.DIRECTORY:
        raise IsADirectoryError(path.virtual)
    data = cast(bytes, await relay(dispatch, "read", path))
    io.reads[path.virtual] = data
    if path.virtual not in io.cache:
        io.cache.append(path.virtual)
    return data


async def _relay_write(dispatch: DispatchFn, path: PathSpec,
                       data: bytes) -> None:
    """Write one whole file on the mount that owns it.

    The door every generic writes through, which the transfer
    commands call with ``data=`` and the archivers call positionally.

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
        path (PathSpec): The file to write.
        data (bytes): Its entire content.
    """
    await dispatch("write", path, data=data)


async def run_operands(run_single: RunSingle,
                       cmd_name: str,
                       scopes: list[PathSpec],
                       texts: list[str],
                       flag_kwargs: dict[str, FlagValue],
                       stdin_bytes: bytes | None = None,
                       stop_at_success: bool = False) -> list[OperandRun]:
    """Run one native single-mount command per operand, in operand order.

    Each operand executes on its owning mount through ``run_single`` (which
    also expands the operand's glob natively). Output is materialized and
    the lazy exit code synced, so combiners see final values.

    Args:
        run_single (RunSingle): Executor-injected single-mount runner.
        cmd_name (str): Command to run for every operand.
        scopes (list[PathSpec]): Path operands in command-line order.
        texts (list[str]): Positional text operands shared by every run.
        flag_kwargs (dict): Flags shared by every run.
        stdin_bytes (bytes | None): Stdin re-fed to every run (tee).
        stop_at_success (bool): run no operand after one that exits 0,
            which is how grep -q and rg -q stop at their first match.
    """
    results: list[OperandRun] = []
    for scope in scopes:
        out, io = await run_single(cmd_name, [scope],
                                   texts,
                                   flag_kwargs,
                                   stdin=stdin_bytes)
        try:
            data = await materialize(out) if out is not None else b""
        except FS_ERRORS as exc:
            # A lazy stream can fail on first pull (head/tail opening the
            # operand mid-drain); report it like the native run would and
            # keep the remaining operands, GNU-style.
            existing = await materialize(io.stderr) if io.stderr else b""
            io.stderr = existing + fs_error_line(cmd_name, scope, exc).encode()
            # The command's own code for a failed read, not the catch-all:
            # a lazy operand that fails here is the same failure the
            # single-mount run reports eagerly, and it must answer the
            # same number.
            io.exit_code = read_fail_exit(cmd_name, exc)
            data = b""
        results.append(OperandRun(scope, data, io))
        if stop_at_success and io.exit_code == 0:
            break
    return results


async def merge_operand_ios(results: list[OperandRun],
                            exit_code: int) -> IOResult:
    """Merge per-operand IOResults in operand order under one exit code.

    Args:
        results (list[OperandRun]): Per-operand runs from ``run_operands``.
        exit_code (int): Combined exit code (each family has its own rule).
    """
    io = IOResult()
    for run in results:
        io = await io.merge(run.io)
    io.exit_code = exit_code
    # A merge keeps the last run's rows; the operands' rows are wanted
    # together and in order, since find's actions run once over all of
    # them at the command boundary (`-exec {} +` is one batch across
    # start points, as in GNU). One run without them means the whole
    # selection is unstructured.
    runs = [run.io.matched_runs for run in results]
    known = [run_rows for run_rows in runs if run_rows is not None]
    io.matched_runs = ([r for run_rows in known for r in run_rows]
                       if len(known) == len(runs) else None)
    return io


def run_separator(cmd_name: str, flags: dict[str, FlagValue]) -> bytes:
    """What sets one run's grep or rg output off from the next's.

    Both print a separator between one file's context and the next file's
    (rg's own, or none under --no-context-separator), and rg a blank line
    between --heading groups, so the runs a line splits into join the way
    one run would. Nothing for any other output, a plain line stream.

    Args:
        cmd_name (str): the command the runs ran.
        flags (dict[str, FlagValue]): its flags.
    """
    if cmd_name == Cmd.RG:
        fl = FlagView(flags, spec=SPECS[Cmd.RG])
        return rg_between_files(parse_rg_flags(fl))
    if cmd_name == Cmd.GREP:
        fl = FlagView(flags, spec=SPECS[Cmd.GREP])
        if grep_prints_context(parse_grep_flags(fl, never_match=False)):
            return b"--\n"
    return b""


def flat_scopes(scopes: list[PathSpec]) -> list[PathSpec]:
    # Address by full virtual path so a generic sees one flat namespace;
    # the relayed primitives route each full path to its mount.
    return [
        dataclasses.replace(s, vfs_path=s.virtual.strip("/")) for s in scopes
    ]


def transfer_primitives(dispatch: DispatchFn) -> dict[str, Any]:
    """Dispatch-relayed primitives shared by the transfer generics (cp/mv).

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
    """
    p = functools.partial
    return dict(
        stat=p(relay, dispatch, "stat"),
        read_bytes=p(relay, dispatch, "read"),
        write=p(_relay_write, dispatch),
        mkdir=p(relay, dispatch, "mkdir"),
        readdir=p(relay, dispatch, "readdir"),
    )
