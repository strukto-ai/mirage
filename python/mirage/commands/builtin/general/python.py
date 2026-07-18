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
from mirage.runtime.python import MontyRuntime
from mirage.types import PathSpec


async def _python3(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    c: str | None = None,
    stdin: ByteSource | None = None,
    dispatch: Callable[..., Any] | None = None,
    cwd: PathSpec | None = None,
    env: dict[str, str] | None = None,
    exec_allowed: bool = True,
    runtime: Runtime | None = None,
    **_extra: object,
) -> CommandOutput:
    error, prepared = await resolve_source("python3", paths, texts, c, stdin,
                                           dispatch, cwd, exec_allowed)
    if error is not None or prepared is None:
        assert error is not None
        return error
    return await run_code("python3",
                          prepared,
                          env, {},
                          runtime,
                          fallback=MontyRuntime,
                          fallback_errors=(ImportError, ),
                          dispatch=dispatch)


python3 = command("python3", resource=None, spec=SPECS["python3"])(_python3)
python_cmd = command("python", resource=None, spec=SPECS["python"])(_python3)
