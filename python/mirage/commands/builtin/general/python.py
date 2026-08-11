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
from mirage.commands.builtin.general.interpreter import (CPYTHON_ARGV0,
                                                         resolve_source,
                                                         run_code)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, CommandOutput
from mirage.runtime.base import Runtime
from mirage.types import PathSpec


async def _python3(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    c: str | None = None,
    m: str | None = None,
    u: bool = False,
    q: bool = False,
    b: int = 0,
    B: bool = False,
    E: bool = False,
    P: bool = False,
    s: bool = False,
    S: bool = False,
    x: bool = False,
    args_I: bool = False,
    args_O: int = 0,
    W: list[str] | None = None,
    X: list[str] | None = None,
    check_hash_based_pycs: str | None = None,
    stdin: ByteSource | None = None,
    dispatch: Callable[..., Any] | None = None,
    cwd: PathSpec | None = None,
    env: dict[str, str] | None = None,
    exec_allowed: bool = True,
    runtime: Runtime | None = None,
    runtime_unavailable: str | None = None,
    **_extra: FlagValue,
) -> CommandOutput:
    error, prepared = await resolve_source("python3", paths, texts, c, stdin,
                                           dispatch, cwd, exec_allowed, m,
                                           CPYTHON_ARGV0, x)
    if error is not None or prepared is None:
        assert error is not None
        return error
    # Keyed by CPython's own letter, which is how mirage.runtime.python
    # .flags reads them; the one long switch is keyed by its canonical
    # spelling, having no letter. -u and -q are absent because mirage
    # buffers every stream and prints no banner, so no engine can
    # differ on them, and -x is absent because it selects source rather
    # than configuring an interpreter, so resolve_source answered it
    # above.
    init_flags: dict[str, Any] = {
        "b": b,
        "B": B,
        "E": E,
        "I": args_I,
        "O": args_O,
        "P": P,
        "s": s,
        "S": S,
        "W": W or [],
        "X": X or [],
        "check_hash_based_pycs": check_hash_based_pycs,
    }
    return await run_code("python3", prepared, env, init_flags, runtime,
                          runtime_unavailable)


python3 = command("python3", resource=None, spec=SPECS["python3"])(_python3)
python_cmd = command("python", resource=None, spec=SPECS["python"])(_python3)
