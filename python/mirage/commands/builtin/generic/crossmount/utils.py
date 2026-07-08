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


async def relay(dispatch: Callable,
                name: str,
                accessor: object,
                path: PathSpec | str,
                index: object = None,
                **kwargs: Any) -> Any:
    # Relay one op for one path to the mount that owns it. The generics call
    # ops as (accessor, path, index); dispatch ignores both and keys off the
    # path. It is also the single place a raw str (the generic's string path
    # arithmetic) is coerced to the PathSpec dispatch needs.
    spec = path if isinstance(path, PathSpec) else PathSpec.from_str_path(path)
    data, _ = await dispatch(name, spec, **kwargs)
    return data


async def stream(dispatch: Callable,
                 accessor: object,
                 path: PathSpec,
                 index: object = None) -> AsyncIterator[bytes]:
    yield await relay(dispatch, "read", accessor, path)


async def run_operands(run_single: RunSingle,
                       cmd_name: str,
                       scopes: list[PathSpec],
                       texts: list[str],
                       flag_kwargs: dict,
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
        data = await materialize(out) if out is not None else b""
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


def transfer_primitives(dispatch: Callable) -> dict[str, Callable]:
    """Dispatch-relayed primitives shared by the transfer generics (cp/mv).

    Args:
        dispatch (Callable): Workspace operation dispatcher.
    """
    p = functools.partial
    return dict(
        stat=p(relay, dispatch, "stat", None),
        read_bytes=p(relay, dispatch, "read", None),
        write=p(relay, dispatch, "write", None),
        mkdir=p(relay, dispatch, "mkdir", None),
        readdir=p(relay, dispatch, "readdir", None),
    )
