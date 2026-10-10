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

import asyncio
import os
import shutil
import sys
from collections.abc import Sequence
from typing import Any, Callable, ClassVar

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.execution import prepare_source
from mirage.runtime.python.flags import init_argv
from mirage.runtime.python.local.config import LocalConfig
from mirage.runtime.types import RunArgs, RunResult, RuntimeReach, ScriptSource

LOCAL_HOME_ENV = "MIRAGE_LOCAL_HOME"


class LocalRuntime(PythonRuntime):
    """Run Python code on a host interpreter as a subprocess.

    Each run spawns `<interpreter> -c <code>`; the code sees the host
    filesystem, not the workspace mounts. Its environment is the
    session's and the config `env`, nothing of mirage's own, as a
    sandlock child gets. Cancelling the run kills the subprocess, so a
    limit timeout reclaims it.

    The interpreter defaults to the one running mirage; point the
    config `home` (the yaml entry's ``config`` block ends up here) or
    the MIRAGE_LOCAL_HOME environment variable at another binary, e.g.
    a project venv whose packages the code needs.
    """

    name = "local"
    # Spawns the host interpreter: a real process with the user's own
    # filesystem and network, entry points the workspace gate never sees.
    # This is the base default; declared here so the claim is explicit
    # at the one builtin runtime that voids a world's sandbox claim.
    reach: RuntimeReach = "process"

    config_cls: ClassVar[type[RuntimeConfig]] = LocalConfig
    config: LocalConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: LocalConfig | dict[str, Any] | None = None,
        script: Callable[..., Any] | ScriptSource | None = None,
    ) -> None:
        super().__init__(captures, config, script)
        chosen = self.config.home or os.environ.get(LOCAL_HOME_ENV)
        if chosen:
            resolved = shutil.which(chosen)
            if resolved is None:
                raise FileNotFoundError(
                    f"local python interpreter not found: {chosen!r} "
                    "(from the runtime entry's config `home` or "
                    f"{LOCAL_HOME_ENV})"
                )
            # Absolute: the program's env has no host PATH to resolve a
            # name found through an empty or `.` entry against.
            self._python = os.path.abspath(resolved)
        else:
            self._python = sys.executable
        # Each running child with the loop it runs on, which alone may
        # wait for it.
        self._children: dict[
            asyncio.subprocess.Process, asyncio.AbstractEventLoop
        ] = {}

    async def version(self, env: dict[str, str]) -> RunResult:
        # Session loader variables can execute code before --version is read.
        return await self._run(["--version"], {})

    async def run(self, args: RunArgs) -> RunResult:
        # Honoring the init switches is just handing them back to the
        # real interpreter, which is why this tier gets them exactly
        # right (sys.flags included) where an in-process engine cannot.
        return await self._run(
            [*init_argv(args.flags), "-c", prepare_source(args), *args.args],
            args.env,
            args.stdin,
        )

    async def _run(
        self, argv: list[str], env: dict[str, str], stdin: bytes | None = None
    ) -> RunResult:
        proc = await asyncio.create_subprocess_exec(
            self._python,
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**self.config.env, **env},
        )
        self._children[proc] = asyncio.get_running_loop()
        try:
            stdout, stderr = await proc.communicate(input=stdin)
        except asyncio.CancelledError:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
            raise
        finally:
            self._children.pop(proc, None)
        return RunResult(
            stdout=stdout,
            stderr=stderr or None,
            exit_code=proc.returncode if proc.returncode is not None else 1,
        )

    async def close(self) -> None:
        """Kill every child still running, so none outlives the workspace.

        Only a child on the closing loop is waited for. One a sync
        ``with`` block left running belongs to the loop that block exits
        inside, which runs nothing until the close returns; that loop
        reaps it once the kill lands.
        """
        children = list(self._children.items())
        for child, _ in children:
            if child.returncode is None:
                child.kill()
        loop = asyncio.get_running_loop()
        await asyncio.gather(
            *(child.wait() for child, owner in children if owner is loop)
        )
