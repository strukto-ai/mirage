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

from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    CrossResult,
    RunSingle,
)
from mirage.commands.builtin.generic.crossmount.utils import (
    merge_operand_ios,
    run_operands,
    stream_operands,
)
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagBag, FlagView
from mirage.commands.spec.types import FlagValue
from mirage.types import PathSpec


async def run_fanout(
    cmd_name: str,
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict[str, FlagValue],
    run_single: RunSingle,
) -> CrossResult:
    """Run a per-operand command whose operands span mounts.

    The command runs natively once per operand on the operand's owning
    mount (globs expand inside that native run), and the outputs combine
    in operand order. Filename-keyed commands stay correct because every
    head/tail run is forced to name its files (``-v``);

    Args:
        cmd_name (str): One of the FANOUT_COMMANDS (or ``sed -i``).
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (grep pattern,
            find expression).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        run_single (RunSingle): Executor-injected single-mount runner.
    """
    flags: dict[str, FlagValue] = FlagBag(flag_kwargs)
    # head pairs -q/--quiet and -v/--verbose (canonical dests), tail
    # declares them short-only.
    quiet_key = "quiet" if cmd_name == Cmd.HEAD else "q"
    verbose_key = "verbose" if cmd_name == Cmd.HEAD else "v"
    if cmd_name in (Cmd.HEAD, Cmd.TAIL) and not FlagView(
        flags, spec=SPECS[cmd_name]
    ).as_bool(quiet_key):
        flags[verbose_key] = True

    if cmd_name not in (
        Cmd.FIND,
        Cmd.RM,
        Cmd.RMDIR,
        Cmd.UNLINK,
        Cmd.TOUCH,
        Cmd.MKDIR,
    ):
        separator = (
            b"\n"
            if cmd_name in (Cmd.HEAD, Cmd.TAIL)
            and FlagView(flags, spec=SPECS[cmd_name]).as_bool(verbose_key)
            else b""
        )
        return await stream_operands(
            run_single, cmd_name, scopes, list(text_args), flags, separator
        )

    results = await run_operands(
        run_single, cmd_name, scopes, list(text_args), flags
    )
    exit_code = max((r.io.exit_code for r in results), default=0)

    body = b"".join(r.data for r in results)

    io = await merge_operand_ios(results, exit_code)
    return body, io
