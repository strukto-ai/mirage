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

import functools
from collections.abc import AsyncIterator

from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic.head import head_multi
from mirage.commands.builtin.generic.tail import tail_multi
from mirage.commands.builtin.generic.wc import format_multi as wc_format_multi
from mirage.commands.builtin.tail_helper import _parse_n
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io import IOResult
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource
from mirage.types import FileStat, FileType, PathSpec
from mirage.workspace.executor.cross.adapter import DispatchIO
from mirage.workspace.executor.cross.types import CrossResult
from mirage.workspace.types import ExecutionNode


async def _served_stream(reads: dict[str, bytes],
                         accessor: object,
                         path: PathSpec,
                         index: object = None) -> AsyncIterator[bytes]:
    yield reads[path.original]


async def _served_bytes(reads: dict[str, bytes],
                        accessor: object,
                        path: PathSpec,
                        index: object = None) -> bytes:
    return reads[path.original]


async def _served_stat(reads: dict[str, bytes],
                       accessor: object,
                       path: PathSpec,
                       index: object = None) -> FileStat:
    # Every operand is read before grep runs, so it is a file, not a
    # directory; the type only has to be non-DIRECTORY for grep's dir guard.
    data = reads[path.original]
    return FileStat(name=path.original.rstrip("/").rsplit("/", 1)[-1],
                    size=len(data),
                    type=FileType.TEXT)


async def _served_readdir(accessor: object,
                          path: PathSpec,
                          index: object = None) -> list[str]:
    return []


def _node(cmd_str: str,
          exit_code: int = 0,
          stderr: bytes | None = None) -> ExecutionNode:
    return ExecutionNode(command=cmd_str, exit_code=exit_code, stderr=stderr)


async def run_aggregate(cmd_name: str, scopes: list[PathSpec],
                        text_args: list[str], flag_kwargs: dict,
                        io: DispatchIO, cmd_str: str) -> CrossResult:
    """Aggregate a multi-file read across mounts by delegating to the generic.

    These are the N-ary read commands: many files in, one aggregated stream
    out. Every operand is read once from its owning mount (through the
    dispatch-backed ``io.read_bytes``); a directory or missing operand fails at
    that read and aborts the command, as for a single-mount file read. The
    bytes are then served back to the shared generic command (the same one
    every backend uses), which does the cat/head/tail/wc/grep aggregation, so
    cross-mount output matches the single-mount commands. Only ``read`` is
    backed by dispatch; ``stat``/``readdir`` are served from the bytes already
    read, so the read family never issues a directory-traversal op.

    Args:
        cmd_name (str): One of cat, head, tail, wc, grep, rg.
        scopes (list[PathSpec]): Resolved file operands spanning mounts.
        text_args (list[str]): Positional text operands (grep pattern).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        io (DispatchIO): Dispatch-backed ops bundle.
        cmd_str (str): Original command text for the execution record.
    """
    show_headers = len(scopes) > 1
    for scope in scopes:
        await io.read_bytes(None, scope)
    reads = io.reads
    result = IOResult(reads=dict(reads), cache=list(reads))
    read = functools.partial(_served_stream, reads)

    if cmd_name in ("grep", "rg"):
        out, gio = await generic_grep(
            scopes,
            text_args,
            flag_kwargs,
            readdir=_served_readdir,
            stat=functools.partial(_served_stat, reads),
            read_bytes=functools.partial(_served_bytes, reads),
            read_stream=read,
            accessor=None,
            show_filename=show_headers)
        return out, gio, _node(cmd_str, gio.exit_code, gio.stderr)

    if cmd_name == "cat":
        source: ByteSource = async_chain(*reads.values())
        return source, result, _node(cmd_str)

    if cmd_name in ("head", "tail"):
        fl = FlagView(flag_kwargs, spec=SPECS[cmd_name])
        n = fl.str("n")
        c = fl.int("c")
        n_int: int | None = None
        from_line: int | None = None
        if n is not None:
            lines, plus_mode = _parse_n(n)
            if plus_mode:
                from_line = lines
            else:
                n_int = lines
        if cmd_name == "head":
            out = head_multi(scopes,
                             read=read,
                             n=n_int,
                             c=c,
                             show_headers=show_headers)
        else:
            out = tail_multi(scopes,
                             read=read,
                             n=n_int,
                             c=c,
                             from_line=from_line,
                             show_headers=show_headers)
        return out, result, _node(cmd_str)

    if cmd_name == "wc":
        fl = FlagView(flag_kwargs, spec=SPECS["wc"])
        body = await wc_format_multi(scopes,
                                     read=read,
                                     args_l=fl.bool("args_l"),
                                     w=fl.bool("w"),
                                     c=fl.bool("c"),
                                     m=fl.bool("m"),
                                     L=fl.bool("L"))
        return body, result, _node(cmd_str)

    source = async_chain(*reads.values())
    return source, result, _node(cmd_str)
