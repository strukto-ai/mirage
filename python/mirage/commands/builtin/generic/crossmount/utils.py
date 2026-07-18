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
from collections.abc import AsyncIterator
from typing import Any, Callable

from mirage.commands.builtin.generic.crossmount.types import (OperandRun,
                                                              RunSingle)
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_error_line


async def relay(dispatch: Callable[..., Any], name: str, path: PathSpec,
                **kwargs: Any) -> Any:
    # Relay one op for one path to the mount that owns it. The generics call
    # ops as (path); dispatch keys off the path.
    data, _ = await dispatch(name, path, **kwargs)
    return data


async def stream(dispatch: Callable[..., Any],
                 path: PathSpec) -> AsyncIterator[bytes]:
    yield await relay(dispatch, "read", path)


async def run_operands(run_single: RunSingle,
                       cmd_name: str,
                       scopes: list[PathSpec],
                       texts: list[str],
                       flag_kwargs: dict[str, object],
                       stdin_bytes: bytes | None = None) -> list[OperandRun]:
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
            io.exit_code = 1
            data = b""
        io.sync_exit_code()
        results.append(OperandRun(scope, data, io))
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
    return io


def flat_scopes(scopes: list[PathSpec]) -> list[PathSpec]:
    # Address by full virtual path so a generic sees one flat namespace;
    # the relayed primitives route each full path to its mount.
    return [
        dataclasses.replace(s, resource_path=s.virtual.strip("/"))
        for s in scopes
    ]


def transfer_primitives(dispatch: Callable[..., Any]) -> dict[str, Any]:
    """Dispatch-relayed primitives shared by the transfer generics (cp/mv).

    Args:
        dispatch (Callable): Workspace operation dispatcher.
    """
    p = functools.partial
    return dict(
        stat=p(relay, dispatch, "stat"),
        read_bytes=p(relay, dispatch, "read"),
        write=p(relay, dispatch, "write"),
        mkdir=p(relay, dispatch, "mkdir"),
        readdir=p(relay, dispatch, "readdir"),
    )
