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

from mirage.commands.builtin.generic.crossmount.primitives import (CrossResult,
                                                                   relay,
                                                                   stream)
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic.head import head_multi
from mirage.commands.builtin.generic.tail import tail_multi
from mirage.commands.builtin.generic.wc import format_multi as wc_format_multi
from mirage.commands.builtin.tail_helper import _parse_n
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io import IOResult
from mirage.io.stream import async_chain
from mirage.types import PathSpec


async def run_read(cmd_name: str, scopes: list[PathSpec], text_args: list[str],
                   flag_kwargs: dict, dispatch) -> CrossResult:
    """Aggregate a multi-file read whose operands span mounts.

    Pure wiring: each operand is read (and for grep stat'd) via its owning
    mount via ``dispatch``-relayed primitives, and the shared generic command
    does the cat/head/tail/wc/grep work, so output matches the single-mount
    commands. The caller builds the execution record.

    Args:
        cmd_name (str): One of cat, head, tail, wc, grep, rg.
        scopes (list[PathSpec]): Resolved file operands spanning mounts.
        text_args (list[str]): Positional text operands (grep pattern).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    p = functools.partial
    read_bytes = p(relay, dispatch, "read")
    read_stream = p(stream, dispatch)
    show_headers = len(scopes) > 1

    if cmd_name in ("grep", "rg"):
        return await generic_grep(scopes,
                                  text_args,
                                  flag_kwargs,
                                  readdir=p(relay, dispatch, "readdir"),
                                  stat=p(relay, dispatch, "stat"),
                                  read_bytes=read_bytes,
                                  read_stream=read_stream,
                                  accessor=None)

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
                             read=read_stream,
                             n=n_int,
                             c=c,
                             show_headers=show_headers)
        else:
            out = tail_multi(scopes,
                             read=read_stream,
                             n=n_int,
                             c=c,
                             from_line=from_line,
                             show_headers=show_headers)
        return out, IOResult()

    if cmd_name == "wc":
        fl = FlagView(flag_kwargs, spec=SPECS["wc"])
        body = await wc_format_multi(scopes,
                                     read=read_stream,
                                     args_l=fl.bool("args_l"),
                                     w=fl.bool("w"),
                                     c=fl.bool("c"),
                                     m=fl.bool("m"),
                                     L=fl.bool("L"))
        return body, IOResult()

    reads: dict[str, bytes] = {}
    for scope in scopes:
        reads[scope.virtual] = await read_bytes(None, scope)
    return async_chain(*reads.values()), IOResult(reads=dict(reads),
                                                  cache=list(reads))
