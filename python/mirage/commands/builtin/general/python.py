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

from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.general.interpreter import (CPYTHON_ARGV0,
                                                         resolve_source,
                                                         run_code)
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import CommandOutput
from mirage.types import PathSpec


async def _python3(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> CommandOutput:
    fl = FlagView(opts.flags, spec=SPECS["python3"])
    error, prepared = await resolve_source("python3", paths, texts,
                                           fl.as_str("c"), opts.stdin,
                                           opts.dispatch,
                                           opts.cwd, opts.exec_allowed,
                                           fl.as_str("m"), CPYTHON_ARGV0,
                                           fl.as_bool("x"))
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
        "check_hash_based_pycs": fl.as_str("check_hash_based_pycs"),
    }
    return await run_code("python3", prepared, opts.env, init_flags,
                          opts.runtime, opts.runtime_unavailable)


python3 = command("python3", resource=None, spec=SPECS["python3"])(_python3)
python_cmd = command("python", resource=None, spec=SPECS["python"])(_python3)
