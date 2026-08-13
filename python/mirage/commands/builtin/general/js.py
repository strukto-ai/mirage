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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.general.interpreter import (resolve_source,
                                                         run_code)
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import CommandOutput
from mirage.types import PathSpec


async def _js(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> CommandOutput:
    fl = FlagView(opts.flags, spec=SPECS["js"])
    error, prepared = await resolve_source("js", paths, texts, fl.as_str("e"),
                                           opts.stdin, opts.dispatch, opts.cwd,
                                           opts.exec_allowed)
    if error is not None or prepared is None:
        assert error is not None
        return error
    as_module = fl.as_bool("module") or (
        prepared.script_path is not None
        and prepared.script_path.virtual.endswith(".mjs"))
    return await run_code("js", prepared, opts.env, {"module": as_module},
                          opts.runtime, opts.runtime_unavailable)


js = command("js", resource=None, spec=SPECS["js"])(_js)
node = command("node", resource=None, spec=SPECS["node"])(_js)
