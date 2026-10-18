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

from mirage.commands.builtin.generic.awk import home_operand
from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    CrossResult,
    RunSingle,
)
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource
from mirage.types import PathSpec


async def run_awk(
    scopes: list[PathSpec],
    text_args: list[str],
    flag_kwargs: dict[str, FlagValue],
    run_single: RunSingle,
    stdin: ByteSource | None,
) -> CrossResult:
    """Run one awk over operands that span mounts, ARGV intact.

    awk tells its operands apart: FILENAME, FNR, ARGV, nextfile and a
    ``var=value`` operand between two files all need each file as its
    own input, which a merged stream cannot give. So the program runs
    once, on the mount of its first file, with every operand in order;
    the files on other mounts read through the dispatcher.

    Args:
        scopes (list[PathSpec]): The operands in command-line order.
        text_args (list[str]): The program text.
        flag_kwargs (dict[str, FlagValue]): Flags parsed against the shared
            command spec.
        run_single (RunSingle): Single-mount runner.
        stdin (ByteSource | None): The line's input.
    """
    return await run_single(
        Cmd.AWK,
        scopes,
        text_args,
        flag_kwargs,
        stdin=stdin,
        resolve_hint=home_operand(scopes),
    )


__all__ = ["run_awk"]
