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
    run_output,
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


async def _js(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> CommandOutput:
    label = (ctx.spec.name if ctx.spec is not None else "") or "js"
    placement = ctx.runtime or CommandRuntime()
    runtime = placement.bound
    if not isinstance(runtime, LanguageRuntime):
        return not_bound(label, placement.unavailable)
    fl = FlagView(ctx.flags, spec=SPECS["js"])
    if fl.as_bool("version"):
        return await runtime_version(runtime, ctx.env)
    switches: dict[str, FlagValue] = {}
    payload = fl.as_str("e")
    if payload is not None:
        switches["c"] = payload
    script = script_operand(paths, texts, switches, ctx.cwd)
    refusal = exec_refusal(label, script, placement)
    if refusal is not None:
        return refusal
    switches["module"] = fl.as_bool("module") or (
        script is not None and script.virtual.endswith(".mjs")
    )
    return run_output(
        await runtime.execute(paths, texts, replace(ctx, flags=switches))
    )


js = command("js", vfs=None, spec=SPECS["js"], write=True)(_js)
node = command("node", vfs=None, spec=SPECS["node"], write=True)(_js)
