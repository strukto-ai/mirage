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

from dataclasses import replace

from mirage.accessor.base import Accessor
from mirage.commands.builtin.general.interpreter import (
    exec_refusal,
    not_bound,
    run_interpreter,
    runtime_version,
)
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import CommandOutput
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.source import script_operand
from mirage.runtime.types import CommandRuntime
from mirage.types import PathSpec


async def _python3(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> CommandOutput:
    label = (ctx.spec.name if ctx.spec is not None else "") or "python3"
    placement = ctx.runtime or CommandRuntime()
    runtime = placement.bound
    if not isinstance(runtime, LanguageRuntime):
        return not_bound(label, placement.unavailable)
    fl = FlagView(ctx.flags, spec=SPECS["python3"])
    if fl.as_bool("version"):
        return await runtime_version(runtime, ctx.env)
    # The runtime's switches, keyed by CPython's own letter, which is how
    # mirage.runtime.python.flags reads them; the one long switch is
    # keyed by its canonical spelling, having no letter. -q is absent
    # because mirage prints no banner, so no engine can differ on it.
    switches: dict[str, FlagValue] = {
        "u": fl.as_bool("u"),
        "b": fl.as_int("b") or 0,
        "B": fl.as_bool("B"),
        "E": fl.as_bool("E"),
        "I": fl.as_bool("args_I"),
        "O": fl.as_int("args_O") or 0,
        "P": fl.as_bool("P"),
        "s": fl.as_bool("s"),
        "S": fl.as_bool("S"),
        "W": fl.as_list("W"),
        "X": fl.as_list("X"),
        "x": fl.as_bool("x"),
    }
    for key, value in (
        ("c", fl.as_str("c")),
        ("m", fl.as_str("m")),
        ("check_hash_based_pycs", fl.as_str("check_hash_based_pycs")),
    ):
        if value is not None:
            switches[key] = value
    refusal = exec_refusal(
        label, script_operand(paths, texts, switches, ctx.cwd), placement
    )
    if refusal is not None:
        return refusal
    return run_interpreter(runtime, paths, texts, replace(ctx, flags=switches))


python3 = command("python3", vfs=None, spec=SPECS["python3"], write=True)(
    _python3
)
python_cmd = command("python", vfs=None, spec=SPECS["python"], write=True)(
    _python3
)
