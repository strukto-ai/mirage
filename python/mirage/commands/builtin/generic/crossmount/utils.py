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

import asyncio
import dataclasses
import functools
from collections import deque
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any, cast

from mirage.commands.builtin.generic.cp import TransferLinks
from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    CrossResult,
    OperandRun,
    RunSingle,
)
from mirage.commands.builtin.generic.grep import (
    parse_flags as parse_grep_flags,
)
from mirage.commands.builtin.generic.grep import (
    prints_context as grep_prints_context,
)
from mirage.commands.builtin.generic.rg import (
    between_files as rg_between_files,
)
from mirage.commands.builtin.generic.rg import parse_flags as parse_rg_flags
from mirage.commands.builtin.generic_bind.adapter import dispatched_call
from mirage.commands.builtin.utils.stream import is_stdin
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import eisdir
from mirage.errors.render import fs_error_line
from mirage.io import IOResult
from mirage.io.cooperative import chunks as byte_chunks
from mirage.io.stream import discard_streams, ensure_stream, materialize
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import FileType, PathSpec, PrimitiveCopy, Visibility
from mirage.view.types import LinkView


async def read_file(dispatch: DispatchFn, path: PathSpec) -> bytes:
    """Read a relayed file.

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
        path (PathSpec): Full virtual input path.
    """
    info = await dispatched_call(dispatch, "stat", path)
    if info.type is FileType.DIRECTORY:
        raise eisdir(path.virtual)
    return cast(bytes, await dispatched_call(dispatch, "read", path))


async def _relay_write(
    dispatch: DispatchFn, path: PathSpec, data: bytes
) -> None:
    """Write one whole file on the mount that owns it.

    The dispatcher every generic writes through, which the transfer
    commands call with ``data=`` and the archivers call positionally.

    Args:
        dispatch (DispatchFn): Workspace operation dispatcher.
        path (PathSpec): The file to write.
        data (bytes): Its entire content.
    """
    await dispatched_call(dispatch, "write", path, data=data)


async def run_operands(
    run_single: RunSingle,
    cmd_name: str,
    scopes: list[PathSpec],
    texts: list[str],
    flag_kwargs: dict[str, FlagValue],
) -> list[OperandRun]:
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
    """
    results: list[OperandRun] = []
    for scope in scopes:
        out, io = await run_single(cmd_name, [scope], texts, flag_kwargs)
        chunks: list[bytes] = []
        try:
            async for chunk in ensure_stream(out or b""):
                chunks.append(chunk)
        except FS_ERRORS as exc:
            # A lazy stream can fail on first pull (head/tail opening the
            # operand mid-drain); report it like the native run would and
            # keep the remaining operands, GNU-style.
            existing = await materialize(io.stderr) if io.stderr else b""
            io.stderr = existing + encode_text(
                fs_error_line(cmd_name, scope, exc)
            )
            # The command's own code for a failed read, not the catch-all:
            # a lazy operand that fails here is the same failure the
            # single-mount run reports eagerly, and it must answer the
            # same number.
            io.exit_code = read_fail_exit_code(cmd_name, exc)
        results.append(OperandRun(scope, b"".join(chunks), io))
    return results


async def merge_operand_ios(
    results: list[OperandRun], exit_code: int
) -> IOResult:
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
    io.matched_runs = (
        [r for run_rows in known for r in run_rows]
        if len(known) == len(runs)
        else None
    )
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
        stat=p(dispatched_call, dispatch, "stat"),
        read_bytes=p(dispatched_call, dispatch, "read"),
        write=p(_relay_write, dispatch),
        mkdir=p(dispatched_call, dispatch, "mkdir"),
        readdir=p(dispatched_call, dispatch, "readdir"),
    )


def transfer_links_of(
    links: LinkView,
    dispatch: DispatchFn,
    cwd: str,
    visibility: Visibility | None,
) -> TransferLinks:
    """Namespace links with the dispatcher primitives shared by cp and mv.

    Args:
        links (LinkView): the namespace's symlink facts.
        dispatch (DispatchFn): the dispatcher.
        cwd (str): the directory a typed operand resolves against.
        visibility (Visibility | None): the session's visibility.
    """
    prim = transfer_primitives(dispatch)
    return TransferLinks(
        links=links,
        dispatch=dispatch,
        cwd=cwd,
        relay=PrimitiveCopy(
            read_bytes=prim["read_bytes"],
            write=prim["write"],
            mkdir=prim["mkdir"],
            readdir=prim["readdir"],
        ),
        relay_stat=prim["stat"],
        visibility=visibility,
    )


async def stream_operands(
    run_single: RunSingle,
    cmd_name: str,
    scopes: list[PathSpec],
    texts: list[str],
    flags: dict[str, FlagValue],
    separator: bytes = b"",
) -> tuple[ByteSource, IOResult]:
    """Stream ordered native reads with at most four open invocations.

    Only independent read families use this path. Later handlers may prepare
    while the current stream is consumed; their streams are not pulled ahead.
    Closing or cancelling the consumer cancels preparations and discards every
    opened stream, including one that finished preparing during cancellation.
    The returned result settles as the stream drains, as any lazy command's
    does: its exit code is final once the stream is exhausted.

    Args:
        run_single (RunSingle): Executor-injected single-mount runner.
        cmd_name (str): Command to run for every operand.
        scopes (list[PathSpec]): Path operands in command-line order.
        texts (list[str]): Positional text operands shared by every run.
        flags (dict[str, FlagValue]): Flags shared by every run.
        separator (bytes): What sets one operand's output off from the
            next's (head and tail headers).
    """
    io = IOResult()

    async def stream() -> AsyncIterator[bytes]:
        pending: deque[tuple[PathSpec, asyncio.Task[CrossResult]]] = deque()
        operands = iter(scopes)
        printed = False

        async def execute(scope: PathSpec) -> CrossResult:
            return await run_single(cmd_name, [scope], texts, flags)

        def start() -> None:
            scope = next(operands, None)
            if scope is not None:
                pending.append(
                    (
                        scope,
                        asyncio.create_task(execute(scope)),
                    )
                )

        concurrency = 1 if any(is_stdin(p) for p in scopes) else 4
        for _ in range(concurrency):
            start()
        try:
            while pending:
                scope, task = pending[0]
                out, branch = await task
                first = True
                try:
                    async with aclosing(byte_chunks(out or b"")) as source:
                        async for data in source:
                            if not data:
                                continue
                            if first and printed and separator:
                                yield separator
                            first = False
                            printed = True
                            yield data
                except FS_ERRORS as exc:
                    existing = await materialize(branch.stderr)
                    branch.stderr = existing + encode_text(
                        fs_error_line(cmd_name, scope, exc)
                    )
                    branch.exit_code = read_fail_exit_code(cmd_name, exc)
                io.stderr = await materialize(io.stderr) + await materialize(
                    branch.stderr
                )
                io.exit_code = max(io.exit_code, branch.exit_code)
                if branch.refusal is not None:
                    io.refusal = branch.refusal
                pending.popleft()
                start()
        finally:
            for _, task in pending:
                if not task.done():
                    task.cancel()
            settled = await asyncio.gather(
                *(task for _, task in pending), return_exceptions=True
            )
            for result in settled:
                if isinstance(result, tuple):
                    out, branch = result
                    await discard_streams(out, branch.stderr)

    return stream(), io
