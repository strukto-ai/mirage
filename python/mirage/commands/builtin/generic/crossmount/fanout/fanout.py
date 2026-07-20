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

from mirage.commands.builtin.generic.crossmount.fanout.du import du_total
from mirage.commands.builtin.generic.crossmount.fanout.exit import \
    combined_exit
from mirage.commands.builtin.generic.crossmount.fanout.wc import combine_wc
from mirage.commands.builtin.generic.crossmount.types import (Cmd, CrossResult,
                                                              RunSingle)
from mirage.commands.builtin.generic.crossmount.utils import (
    merge_operand_ios, run_operands)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.types import PathSpec


async def run_fanout(cmd_name: str,
                     scopes: list[PathSpec],
                     text_args: list[str],
                     flag_kwargs: dict[str, object],
                     run_single: RunSingle,
                     stdin: ByteSource | None = None) -> CrossResult:
    """Run a per-operand command whose operands span mounts.

    The command runs natively once per operand on the operand's owning
    mount (globs expand inside that native run), and the outputs combine
    in operand order. Filename-keyed commands stay correct because every
    native run is forced to name its files (grep ``-H``, head/tail ``-v``);
    wc and ``du -c`` re-total across runs.

    Args:
        cmd_name (str): One of the FANOUT_COMMANDS (or ``sed -i``).
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): Positional text operands (grep pattern,
            find expression).
        flag_kwargs (dict): Flags parsed against the shared command spec.
        run_single (RunSingle): Executor-injected single-mount runner.
        stdin (ByteSource | None): Original stdin, re-fed per operand (tee).
    """
    flags = dict(flag_kwargs)
    stdin_bytes: bytes | None = None
    if cmd_name == Cmd.TEE:
        stdin_bytes = await materialize(stdin) if stdin is not None else b""
    if cmd_name == Cmd.GREP and not FlagView(
            flags, spec=SPECS[Cmd.GREP]).as_bool("h"):
        flags["H"] = True
    if cmd_name == Cmd.RG and not FlagView(
            flags, spec=SPECS[Cmd.RG]).as_bool("args_I"):
        flags["H"] = True
    if cmd_name in (Cmd.HEAD, Cmd.TAIL) and not FlagView(
            flags, spec=SPECS[cmd_name]).as_bool("q"):
        flags["v"] = True

    results = await run_operands(run_single,
                                 cmd_name,
                                 scopes,
                                 list(text_args),
                                 flags,
                                 stdin_bytes=stdin_bytes)
    errored = [
        r.io.exit_code != 0 and r.io.stderr is not None for r in results
    ]
    quiet = cmd_name == Cmd.GREP and FlagView(
        flags, spec=SPECS[Cmd.GREP]).as_bool("q")
    exit_code = combined_exit(cmd_name, [r.io.exit_code for r in results],
                              errored, quiet)

    if cmd_name == Cmd.WC:
        body = combine_wc(results, flag_kwargs)
    elif cmd_name == Cmd.DU and FlagView(flag_kwargs,
                                         spec=SPECS[Cmd.DU]).as_bool("c"):
        body = du_total(results,
                        FlagView(flag_kwargs, spec=SPECS[Cmd.DU]).as_bool("h"))
    elif cmd_name == Cmd.TEE:
        body = stdin_bytes or b""
    elif (cmd_name in (Cmd.HEAD, Cmd.TAIL)
          and FlagView(flags, spec=SPECS[cmd_name]).as_bool("v")) or (
              cmd_name == Cmd.LS
              and FlagView(flags, spec=SPECS[Cmd.LS]).as_bool("R")):
        # Blank line between per-operand blocks, like one native run
        # separates its own file blocks.
        body = b"\n".join(r.data for r in results if r.data)
    else:
        body = b"".join(r.data for r in results)

    io = await merge_operand_ios(results, exit_code)
    return body, io
