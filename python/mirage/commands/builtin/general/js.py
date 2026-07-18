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

from typing import Any, Callable

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.general.interpreter import (resolve_source,
                                                         run_code)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, CommandOutput
from mirage.runtime.base import Runtime
from mirage.runtime.js import QuickJsRuntime
from mirage.types import PathSpec


async def _js(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    e: str | None = None,
    m: bool = False,
    module: bool = False,
    stdin: ByteSource | None = None,
    dispatch: Callable[..., Any] | None = None,
    cwd: PathSpec | None = None,
    env: dict[str, str] | None = None,
    exec_allowed: bool = True,
    runtime: Runtime | None = None,
    **_extra: object,
) -> CommandOutput:
    error, prepared = await resolve_source("js", paths, texts, e, stdin,
                                           dispatch, cwd, exec_allowed)
    if error is not None or prepared is None:
        assert error is not None
        return error
    as_module = m or module or (prepared.script_path is not None and
                                prepared.script_path.virtual.endswith(".mjs"))
    return await run_code("js",
                          prepared,
                          env, {"module": as_module},
                          runtime,
                          fallback=QuickJsRuntime,
                          fallback_errors=(ImportError, FileNotFoundError),
                          dispatch=dispatch)


js = command("js", resource=None, spec=SPECS["js"])(_js)
node = command("node", resource=None, spec=SPECS["node"])(_js)
