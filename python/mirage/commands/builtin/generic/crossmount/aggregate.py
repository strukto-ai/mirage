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
from typing import Callable

from mirage.commands.builtin.generic.crossmount.primitives import (CrossResult,
                                                                   relay)
from mirage.commands.builtin.generic.du import du_multi
from mirage.commands.builtin.generic.file import file_cmd
from mirage.commands.builtin.generic.md5 import md5 as generic_md5
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io import IOResult
from mirage.types import FileType, PathSpec


async def _du_walk(dispatch: Callable, path: PathSpec) -> int:
    """Total bytes under one operand via relayed stat/readdir.

    Mirrors the factory du builder's walk fallback for backends without
    a native du op, so cross-mount totals match single-mount ones.
    """
    try:
        s = await relay(dispatch, "stat", None, path)
    except (FileNotFoundError, ValueError):
        return 0
    if s.type != FileType.DIRECTORY:
        return s.size or 0
    try:
        children = await relay(dispatch, "readdir", None, path)
    except (FileNotFoundError, ValueError):
        return 0
    total = 0
    for child in children:
        total += await _du_walk(dispatch, PathSpec.from_str_path(child))
    return total


async def run_aggregate(cmd_name: str, scopes: list[PathSpec],
                        flag_kwargs: dict, dispatch: Callable) -> CrossResult:
    """Run a per-operand aggregating command whose operands span mounts.

    Pure wiring: every operand is stat'd or read via ``dispatch``-relayed
    primitives on its owning mount, and the shared generic (du/md5/file)
    formats the output, so it matches the single-mount commands line for
    line. du totals come from the same walk the factory builder uses for
    backends without a native du op; ``-a``/``--max-depth`` degrade to one
    line per operand there, and do the same here.

    Args:
        cmd_name (str): One of du, md5, file.
        scopes (list[PathSpec]): Resolved operands spanning mounts.
        flag_kwargs (dict): Flags parsed against the shared command spec.
        dispatch (Callable): Workspace operation dispatcher.
    """
    p = functools.partial
    if cmd_name == "du":
        fl = FlagView(flag_kwargs, spec=SPECS["du"])
        max_depth = fl.str("max_depth")
        out = await du_multi(
            scopes,
            compute_total=p(_du_walk, dispatch),
            h=fl.bool("h"),
            s=fl.bool("s"),
            a=fl.bool("a"),
            max_depth=int(max_depth) if max_depth is not None else None,
            c=fl.bool("c"))
        return out, IOResult()
    if cmd_name == "md5":
        return await generic_md5(scopes, read_bytes=p(relay, dispatch, "read"))
    fl = FlagView(flag_kwargs, spec=SPECS["file"])
    return await file_cmd(scopes,
                          read_bytes=p(relay, dispatch, "read"),
                          stat_fn=p(relay, dispatch, "stat"),
                          b=fl.bool("b"),
                          i=fl.bool("i"))
